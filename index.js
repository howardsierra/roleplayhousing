// Roleplay Housing — keeps track of where {{char}} and {{user}} live.
// Housing is stored per chat, auto-filled from the character card / persona when it
// mentions a home, editable by hand, and injected into the prompt every generation.

const MODULE_NAME = 'roleplay_housing';
const METADATA_KEY = 'roleplay_housing';
const PROMPT_KEY = 'roleplay_housing';
const EXT_PATH = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const OWNERS = ['char', 'user', 'shared'];
const ARRANGEMENTS = ['unspecified', 'separate', 'together'];

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoDetect: 'auto',
    position: 0,
    depth: 4,
    role: 0,
    template: '[Housing details for this roleplay. Keep descriptions of homes consistent with these facts.]\n{{housing}}',
    includeRooms: true,
    responseLength: 1200,
});

// Words that suggest a card describes somewhere a character lives.
const HOUSING_HINT = /\b(lives?|living|lived|resid(?:es?|ence|ing)|home|house|apartment|apt|flat|condo|loft|studio|penthouse|mansion|manor|estate|villa|cottage|cabin|hut|shack|farmhouse|ranch|trailer|caravan|dorm(?:itory)?|bedroom|room(?:mate)?s?|castle|palace|tower|fortress|tavern|inn|barracks|quarters|bunker|hideout|lair|treehouse|houseboat|townhouse|duplex|bungalow|chalet|rent(?:s|ed|ing)?|landlord|tenant|moved? in|roommates?)\b/i;

let detecting = false;

// ---------------------------------------------------------------------------
// Helpers

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const store = ctx().extensionSettings;
    store[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, store[MODULE_NAME] ?? {});
    return store[MODULE_NAME];
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function uid() {
    return Math.random().toString(36).slice(2, 10);
}

function str(value, max = 4000) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function charName() {
    return ctx().name2 || 'Character';
}

function userName() {
    return ctx().name1 || 'User';
}

function ownerLabel(owner) {
    if (owner === 'char') return `${charName()}'s home`;
    if (owner === 'user') return `${userName()}'s home`;
    return `Shared home (${charName()} & ${userName()})`;
}

function hasChat() {
    return Boolean(ctx().getCurrentChatId?.());
}

// ---------------------------------------------------------------------------
// Data model

function emptyHome(owner = 'char') {
    return { id: uid(), owner, name: '', type: '', location: '', description: '', rooms: [], amenities: [], notes: '', source: 'manual' };
}

function emptyHousing() {
    return { version: 1, arrangement: 'unspecified', homes: [], notes: '', checked: false, source: 'manual' };
}

function normalizeList(value) {
    if (Array.isArray(value)) return value.map(v => str(typeof v === 'string' ? v : v?.name ?? '', 200)).filter(Boolean);
    if (typeof value === 'string') return value.split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
    return [];
}

function normalizeRooms(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(room => (typeof room === 'string'
            ? { name: str(room, 120), details: '' }
            : { name: str(room?.name, 120), details: str(room?.details ?? room?.description, 1000) }))
        .filter(room => room.name || room.details);
}

function normalizeHome(raw, source) {
    const owner = OWNERS.includes(raw?.owner) ? raw.owner : 'char';
    return {
        id: str(raw?.id, 20) || uid(),
        owner,
        name: str(raw?.name, 200),
        type: str(raw?.type, 200),
        location: str(raw?.location, 400),
        description: str(raw?.description),
        rooms: normalizeRooms(raw?.rooms),
        amenities: normalizeList(raw?.amenities),
        notes: str(raw?.notes),
        source: source ?? (['card', 'generated', 'manual'].includes(raw?.source) ? raw.source : 'manual'),
    };
}

function normalizeHousing(raw) {
    const base = emptyHousing();
    if (!raw || typeof raw !== 'object') return base;
    return {
        ...base,
        arrangement: ARRANGEMENTS.includes(raw.arrangement) ? raw.arrangement : 'unspecified',
        homes: Array.isArray(raw.homes) ? raw.homes.map(h => normalizeHome(h)) : [],
        notes: str(raw.notes),
        checked: Boolean(raw.checked),
        source: str(raw.source, 20) || 'manual',
    };
}

function getHousing() {
    return normalizeHousing(ctx().chatMetadata?.[METADATA_KEY]);
}

async function saveHousing(housing) {
    const context = ctx();
    if (!hasChat()) {
        toastr.warning('Open a chat first — housing is saved per chat.', 'Roleplay Housing');
        return false;
    }
    context.chatMetadata[METADATA_KEY] = normalizeHousing(housing);
    updatePrompt();
    if (typeof context.saveMetadata === 'function') await context.saveMetadata();
    else context.saveMetadataDebounced?.();
    return true;
}

function isEmpty(housing) {
    return housing.homes.length === 0 && housing.arrangement === 'unspecified' && !housing.notes;
}

// ---------------------------------------------------------------------------
// Prompt

function describeHome(home, includeRooms) {
    const lines = [];
    const header = [home.name, home.type].filter(Boolean).join(' — ');
    lines.push(`${ownerLabel(home.owner)}${header ? `: ${header}` : ''}`);
    if (home.location) lines.push(`Location: ${home.location}`);
    if (home.description) lines.push(home.description);
    if (includeRooms && home.rooms.length) {
        lines.push('Layout:');
        for (const room of home.rooms) lines.push(`- ${room.name}${room.details ? `: ${room.details}` : ''}`);
    }
    if (home.amenities.length) lines.push(`Amenities: ${home.amenities.join(', ')}`);
    if (home.notes) lines.push(`Notes: ${home.notes}`);
    return lines.join('\n');
}

function buildHousingText(housing = getHousing()) {
    const s = settings();
    const parts = [];
    if (housing.arrangement === 'together') parts.push(`Living arrangement: ${charName()} and ${userName()} live together.`);
    if (housing.arrangement === 'separate') parts.push(`Living arrangement: ${charName()} and ${userName()} live in separate homes.`);
    for (const home of housing.homes) parts.push(describeHome(home, s.includeRooms));
    if (housing.notes) parts.push(`Other housing notes: ${housing.notes}`);
    return parts.join('\n\n');
}

function updatePrompt() {
    const context = ctx();
    const s = settings();
    const housing = hasChat() ? getHousing() : emptyHousing();
    const text = s.enabled && !isEmpty(housing) ? buildHousingText(housing) : '';
    const value = text ? (s.template.includes('{{housing}}') ? s.template.replace('{{housing}}', text) : `${s.template}\n${text}`) : '';
    context.setExtensionPrompt(PROMPT_KEY, value, Number(s.position), Number(s.depth), false, Number(s.role));
}

// ---------------------------------------------------------------------------
// Model calls

async function callModel(prompt, systemPrompt) {
    const context = ctx();
    const responseLength = Number(settings().responseLength) || DEFAULT_SETTINGS.responseLength;
    return await context.generateRaw({ prompt, systemPrompt, responseLength });
}

function extractJson(text) {
    if (typeof text !== 'string') return text && typeof text === 'object' ? text : null;
    const cleaned = text.replace(/```(?:json)?/gi, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return null;
    }
}

function cardSources() {
    const context = ctx();
    const character = context.characters?.[context.characterId];
    const fields = context.getCharacterCardFields?.() ?? {};
    return {
        description: fields.description ?? character?.description ?? '',
        personality: fields.personality ?? character?.personality ?? '',
        scenario: fields.scenario ?? character?.scenario ?? '',
        firstMessage: character?.first_mes ?? '',
        persona: fields.persona ?? context.powerUserSettings?.persona_description ?? '',
    };
}

const HOME_SCHEMA_TEXT = `{
  "owner": "char" | "user" | "shared",
  "name": "short name of the home, e.g. 'The Harbor Street Apartment'",
  "type": "kind of dwelling, e.g. 'two-bedroom apartment'",
  "location": "where it is (city, neighbourhood, world location)",
  "description": "2-4 sentences on look, atmosphere and condition",
  "rooms": [{ "name": "room name", "details": "one sentence on furnishings / notable features" }],
  "amenities": ["short amenity", "..."],
  "notes": "rent, ownership, neighbours, quirks — optional"
}`;

async function detectFromCard({ silent = false } = {}) {
    const context = ctx();
    if (context.characterId === undefined && !context.groupId) {
        if (!silent) toastr.info('Select a character first.', 'Roleplay Housing');
        return null;
    }
    const src = cardSources();
    const sourceText = [
        src.description && `### ${charName()} — description\n${src.description}`,
        src.personality && `### ${charName()} — personality\n${src.personality}`,
        src.scenario && `### Scenario\n${src.scenario}`,
        src.firstMessage && `### First message\n${src.firstMessage}`,
        src.persona && `### ${userName()} (the user's persona)\n${src.persona}`,
    ].filter(Boolean).join('\n\n');

    if (!sourceText.trim()) {
        if (!silent) toastr.info('The card and persona are empty — nothing to read.', 'Roleplay Housing');
        return null;
    }

    const systemPrompt = 'You extract facts from roleplay character cards and reply with JSON only.';
    const prompt = context.substituteParams(`Read the material below and extract where ${charName()} and ${userName()} live.

Rules:
- Only include housing that is stated or clearly implied by the text. Do NOT invent homes.
- "char" = ${charName()}'s home, "user" = ${userName()}'s home, "shared" = a home they share.
- Rooms and amenities: list only those mentioned or obviously implied; leave arrays empty otherwise.
- "arrangement" is "together" if they live together, "separate" if both homes are known and different, else "unspecified".
- If no housing is mentioned at all, return {"arrangement":"unspecified","homes":[]}.

Reply with a single JSON object shaped like:
{ "arrangement": "...", "homes": [ ${HOME_SCHEMA_TEXT} ] }

--- MATERIAL ---
${sourceText}
--- END ---`);

    const toast = silent ? null : toastr.info('Reading the card for housing…', 'Roleplay Housing', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const raw = await callModel(prompt, systemPrompt);
        const parsed = extractJson(raw);
        if (!parsed) throw new Error('The model did not return valid JSON.');
        return {
            arrangement: ARRANGEMENTS.includes(parsed.arrangement) ? parsed.arrangement : 'unspecified',
            homes: (Array.isArray(parsed.homes) ? parsed.homes : []).map(h => normalizeHome(h, 'card')),
        };
    } catch (error) {
        console.error('[Roleplay Housing] Card detection failed', error);
        if (!silent) toastr.error(String(error?.message ?? error), 'Roleplay Housing: card reading failed');
        return null;
    } finally {
        if (toast) toastr.clear(toast);
    }
}

async function generateHome(home, brief) {
    const context = ctx();
    const src = cardSources();
    const known = describeHome(home, true);
    const prompt = context.substituteParams(`You are helping set up a roleplay between ${charName()} and ${userName()}.
Design ${ownerLabel(home.owner)} in detail.

${brief ? `What the user wants: ${brief}\n` : ''}What is already known (keep all of it, expand on it):
${known}

Character context (for tone and consistency):
${[src.description, src.scenario].filter(Boolean).join('\n\n').slice(0, 4000) || '(none)'}
${home.owner !== 'char' && src.persona ? `\n${userName()}'s persona:\n${src.persona.slice(0, 2000)}` : ''}

Give a believable layout of 4-10 rooms/areas and 5-12 amenities that fit the setting and the occupants' means.
Reply with JSON only, a single object shaped like:
${HOME_SCHEMA_TEXT}`);

    const toast = toastr.info('Designing the home…', 'Roleplay Housing', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const raw = await callModel(prompt, 'You design believable homes for roleplay settings and reply with JSON only.');
        const parsed = extractJson(raw);
        if (!parsed) throw new Error('The model did not return valid JSON.');
        const result = normalizeHome({ ...parsed, owner: home.owner, id: home.id }, home.source === 'card' ? 'card' : 'generated');
        // Never throw away what the user (or the card) already set.
        return {
            ...result,
            name: home.name || result.name,
            type: home.type || result.type,
            location: home.location || result.location,
            description: home.description || result.description,
            rooms: mergeRooms(home.rooms, result.rooms),
            amenities: [...new Set([...home.amenities, ...result.amenities])],
            notes: home.notes || result.notes,
        };
    } catch (error) {
        console.error('[Roleplay Housing] Generation failed', error);
        toastr.error(String(error?.message ?? error), 'Roleplay Housing: generation failed');
        return null;
    } finally {
        toastr.clear(toast);
    }
}

function mergeRooms(existing, incoming) {
    const seen = new Set(existing.map(r => r.name.toLowerCase()));
    return [...existing, ...incoming.filter(r => !seen.has(r.name.toLowerCase()))];
}

// ---------------------------------------------------------------------------
// Auto-detect on chat load

function cardMentionsHousing() {
    const src = cardSources();
    return HOUSING_HINT.test([src.description, src.personality, src.scenario, src.firstMessage, src.persona].join('\n'));
}

async function maybeAutoDetect() {
    const s = settings();
    const context = ctx();
    if (detecting || s.autoDetect === 'off' || !hasChat()) return;
    if (context.characterId === undefined || context.groupId) return;

    const housing = getHousing();
    if (housing.checked || !isEmpty(housing)) return;

    const chatId = context.getCurrentChatId();
    const markChecked = async () => {
        if (ctx().getCurrentChatId() !== chatId) return;
        await saveHousing({ ...getHousing(), checked: true });
    };

    if (!cardMentionsHousing()) {
        await markChecked();
        return;
    }

    if (s.autoDetect === 'ask') {
        toastr.info('This card mentions a home. Click to import it into Roleplay Housing.', 'Roleplay Housing', {
            timeOut: 15000,
            onclick: () => runDetectAndOpen(),
        });
        await markChecked();
        return;
    }

    detecting = true;
    try {
        const result = await detectFromCard({ silent: true });
        if (ctx().getCurrentChatId() !== chatId) return;
        if (result && result.homes.length) {
            await saveHousing({ ...getHousing(), ...result, checked: true, source: 'card' });
            const names = result.homes.map(h => h.name || ownerLabel(h.owner)).join(', ');
            toastr.success(`Imported from the card: ${names}. Click to review or edit.`, 'Roleplay Housing', {
                timeOut: 8000,
                onclick: () => openEditor(),
            });
        } else {
            await markChecked();
        }
    } finally {
        detecting = false;
    }
}

async function runDetectAndOpen() {
    const result = await detectFromCard();
    if (!result) return;
    if (!result.homes.length) {
        toastr.info('No housing found in the card. You can describe it yourself.', 'Roleplay Housing');
        openEditor();
        return;
    }
    const current = getHousing();
    await saveHousing({ ...current, arrangement: result.arrangement !== 'unspecified' ? result.arrangement : current.arrangement, homes: mergeCardHomes(current.homes, result.homes), checked: true });
    openEditor();
}

// Card results replace earlier card-sourced homes for the same owner; manual homes are kept.
function mergeCardHomes(existing, incoming) {
    const replacedOwners = new Set(incoming.map(h => h.owner));
    return [...existing.filter(h => h.source !== 'card' || !replacedOwners.has(h.owner)), ...incoming];
}

// ---------------------------------------------------------------------------
// Editor popup

const SOURCE_BADGE = {
    card: '<span class="rph-badge rph-badge-card" title="Filled from the character card">from card</span>',
    generated: '<span class="rph-badge rph-badge-gen" title="Designed by the model">generated</span>',
    manual: '',
};

function renderHomeCard(home) {
    const rooms = home.rooms.map((room, i) => `
        <div class="rph-room" data-index="${i}">
            <input class="text_pole rph-room-name" placeholder="Room" value="${escapeHtml(room.name)}" />
            <input class="text_pole rph-room-details" placeholder="Details" value="${escapeHtml(room.details)}" />
            <div class="menu_button menu_button_icon rph-room-remove" title="Remove room"><i class="fa-solid fa-xmark"></i></div>
        </div>`).join('');

    return `
    <div class="rph-home" data-id="${escapeHtml(home.id)}">
        <div class="rph-home-header">
            <select class="text_pole rph-owner">
                ${OWNERS.map(o => `<option value="${o}" ${o === home.owner ? 'selected' : ''}>${escapeHtml(ownerLabel(o))}</option>`).join('')}
            </select>
            ${SOURCE_BADGE[home.source] ?? ''}
            <div class="menu_button menu_button_icon rph-home-remove" title="Delete this home"><i class="fa-solid fa-trash-can"></i></div>
        </div>
        <div class="rph-grid">
            <label>Name<input class="text_pole rph-field" data-field="name" placeholder="e.g. The Harbor Street Apartment" value="${escapeHtml(home.name)}" /></label>
            <label>Type<input class="text_pole rph-field" data-field="type" placeholder="e.g. cramped studio, castle, dorm room" value="${escapeHtml(home.type)}" /></label>
            <label class="rph-span">Location<input class="text_pole rph-field" data-field="location" placeholder="City, neighbourhood, world location…" value="${escapeHtml(home.location)}" /></label>
            <label class="rph-span">Description<textarea class="text_pole rph-field" data-field="description" rows="3" placeholder="Look, atmosphere, condition…">${escapeHtml(home.description)}</textarea></label>
        </div>
        <div class="rph-section-title">Layout</div>
        <div class="rph-rooms">${rooms || '<div class="rph-empty">No rooms yet.</div>'}</div>
        <div class="menu_button menu_button_icon rph-room-add"><i class="fa-solid fa-plus"></i><span>Add room</span></div>
        <label>Amenities <small>(comma or newline separated)</small>
            <textarea class="text_pole rph-amenities" rows="2" placeholder="washer/dryer, rooftop access, fireplace…">${escapeHtml(home.amenities.join(', '))}</textarea>
        </label>
        <label>Notes<textarea class="text_pole rph-field" data-field="notes" rows="2" placeholder="Rent, ownership, neighbours, quirks…">${escapeHtml(home.notes)}</textarea></label>
        <div class="rph-generate">
            <input class="text_pole rph-brief" placeholder="Describe it in a sentence, e.g. 'a cozy rundown farmhouse with a big porch'" />
            <div class="menu_button menu_button_icon rph-generate-btn" title="Let the model fill in layout and amenities (keeps what you've written)">
                <i class="fa-solid fa-wand-magic-sparkles"></i><span>Flesh out</span>
            </div>
        </div>
    </div>`;
}

function renderEditor(state) {
    return `
    <div class="rph-editor">
        <h3><i class="fa-solid fa-house-chimney"></i> Housing — ${escapeHtml(charName())} &amp; ${escapeHtml(userName())}</h3>
        <div class="rph-toolbar">
            <label>Living arrangement
                <select class="text_pole rph-arrangement">
                    <option value="unspecified" ${state.arrangement === 'unspecified' ? 'selected' : ''}>Unspecified</option>
                    <option value="separate" ${state.arrangement === 'separate' ? 'selected' : ''}>Live separately</option>
                    <option value="together" ${state.arrangement === 'together' ? 'selected' : ''}>Live together</option>
                </select>
            </label>
            <div class="rph-toolbar-buttons">
                <div class="menu_button menu_button_icon rph-add" data-owner="char"><i class="fa-solid fa-plus"></i><span>${escapeHtml(charName())}'s home</span></div>
                <div class="menu_button menu_button_icon rph-add" data-owner="user"><i class="fa-solid fa-plus"></i><span>${escapeHtml(userName())}'s home</span></div>
                <div class="menu_button menu_button_icon rph-add" data-owner="shared"><i class="fa-solid fa-plus"></i><span>Shared home</span></div>
                <div class="menu_button menu_button_icon rph-detect" title="Read the character card and persona for housing"><i class="fa-solid fa-id-card"></i><span>Read from card</span></div>
            </div>
        </div>
        <div class="rph-homes">
            ${state.homes.length ? state.homes.map(renderHomeCard).join('') : '<div class="rph-empty">No housing yet. Add a home above, or read it from the character card.</div>'}
        </div>
        <label>Other housing notes<textarea class="text_pole rph-notes" rows="2" placeholder="Anything else the model should know (e.g. they are house-hunting, visiting each other's places…)">${escapeHtml(state.notes)}</textarea></label>
        <details class="rph-preview">
            <summary>Preview what gets sent to the model</summary>
            <pre class="rph-preview-text"></pre>
        </details>
    </div>`;
}

async function openEditor() {
    const context = ctx();
    if (!hasChat()) {
        toastr.warning('Open a chat first — housing is saved per chat.', 'Roleplay Housing');
        return;
    }

    let state = structuredClone(getHousing());
    const root = $('<div class="rph-root"></div>');

    const findHome = el => state.homes.find(h => h.id === $(el).closest('.rph-home').data('id'));
    const refreshPreview = () => root.find('.rph-preview-text').text(buildHousingText(state) || '(nothing — housing is empty)');
    const rerender = () => {
        root.html(renderEditor(state));
        refreshPreview();
    };

    root.on('input change', '.rph-arrangement', e => { state.arrangement = e.target.value; refreshPreview(); });
    root.on('input', '.rph-notes', e => { state.notes = e.target.value; refreshPreview(); });
    root.on('input', '.rph-field', e => {
        const home = findHome(e.target);
        if (home) home[e.target.dataset.field] = e.target.value;
        refreshPreview();
    });
    root.on('input', '.rph-amenities', e => {
        const home = findHome(e.target);
        if (home) home.amenities = normalizeList(e.target.value);
        refreshPreview();
    });
    root.on('change', '.rph-owner', e => {
        const home = findHome(e.target);
        if (home) home.owner = e.target.value;
        refreshPreview();
    });
    root.on('input', '.rph-room-name, .rph-room-details', e => {
        const home = findHome(e.target);
        const index = Number($(e.target).closest('.rph-room').data('index'));
        if (!home?.rooms[index]) return;
        home.rooms[index][$(e.target).hasClass('rph-room-name') ? 'name' : 'details'] = e.target.value;
        refreshPreview();
    });
    root.on('click', '.rph-room-add', e => {
        findHome(e.currentTarget)?.rooms.push({ name: '', details: '' });
        rerender();
    });
    root.on('click', '.rph-room-remove', e => {
        const home = findHome(e.currentTarget);
        home?.rooms.splice(Number($(e.currentTarget).closest('.rph-room').data('index')), 1);
        rerender();
    });
    root.on('click', '.rph-add', e => {
        state.homes.push(emptyHome(e.currentTarget.dataset.owner));
        if (e.currentTarget.dataset.owner === 'shared') state.arrangement = 'together';
        rerender();
    });
    root.on('click', '.rph-home-remove', e => {
        const home = findHome(e.currentTarget);
        state.homes = state.homes.filter(h => h !== home);
        rerender();
    });
    root.on('click', '.rph-detect', async () => {
        const result = await detectFromCard();
        if (!result) return;
        if (!result.homes.length) {
            toastr.info('No housing found in the card or persona.', 'Roleplay Housing');
            return;
        }
        state.homes = mergeCardHomes(state.homes, result.homes);
        if (result.arrangement !== 'unspecified') state.arrangement = result.arrangement;
        state.checked = true;
        rerender();
        toastr.success(`Found ${result.homes.length} home(s). Review and save.`, 'Roleplay Housing');
    });
    root.on('click', '.rph-generate-btn', async e => {
        const home = findHome(e.currentTarget);
        if (!home) return;
        const brief = $(e.currentTarget).closest('.rph-generate').find('.rph-brief').val();
        const button = $(e.currentTarget).addClass('disabled');
        try {
            const result = await generateHome(normalizeHome(home), String(brief ?? '').trim());
            if (result) {
                state.homes = state.homes.map(h => (h.id === home.id ? result : h));
                rerender();
            }
        } finally {
            button.removeClass('disabled');
        }
    });

    rerender();

    const chatId = context.getCurrentChatId();
    const result = await context.callGenericPopup(root, context.POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
    });

    if (result !== context.POPUP_RESULT.AFFIRMATIVE) return;
    if (ctx().getCurrentChatId() !== chatId) {
        toastr.warning('The chat changed while the editor was open; changes were not saved.', 'Roleplay Housing');
        return;
    }
    state.homes = state.homes.map(h => normalizeHome(h)).filter(h => h.name || h.type || h.location || h.description || h.rooms.length || h.amenities.length || h.notes);
    state.checked = true;
    if (await saveHousing(state)) toastr.success('Housing saved.', 'Roleplay Housing');
}

// ---------------------------------------------------------------------------
// Settings panel, wand menu, slash commands, macros

function bindSettings() {
    const save = () => {
        ctx().saveSettingsDebounced();
        updatePrompt();
    };
    const load = () => {
        const cur = settings();
        $('#rph_enabled').prop('checked', cur.enabled);
        $('#rph_auto_detect').val(cur.autoDetect);
        $('#rph_position').val(String(cur.position));
        $('#rph_depth').val(cur.depth);
        $('#rph_role').val(String(cur.role));
        $('#rph_template').val(cur.template);
        $('#rph_include_rooms').prop('checked', cur.includeRooms);
        $('#rph_response_length').val(cur.responseLength);
    };
    load();

    $('#rph_open').on('click', () => openEditor());
    $('#rph_enabled').on('change', e => { settings().enabled = e.target.checked; save(); });
    $('#rph_auto_detect').on('change', e => { settings().autoDetect = e.target.value; save(); });
    $('#rph_position').on('change', e => { settings().position = Number(e.target.value); save(); });
    $('#rph_depth').on('input', e => { settings().depth = Math.max(0, Number(e.target.value) || 0); save(); });
    $('#rph_role').on('change', e => { settings().role = Number(e.target.value); save(); });
    $('#rph_template').on('input', e => { settings().template = e.target.value; save(); });
    $('#rph_include_rooms').on('change', e => { settings().includeRooms = e.target.checked; save(); });
    $('#rph_response_length').on('input', e => { settings().responseLength = Number(e.target.value) || DEFAULT_SETTINGS.responseLength; save(); });
    $('#rph_reset').on('click', () => {
        ctx().extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
        load();
        save();
    });
}

async function mountSettings() {
    const html = await (await fetch(`${EXT_PATH}/settings.html`)).text();
    $('#extensions_settings2').append(html);
    bindSettings();
}

function mountWandButton() {
    const button = $(`
        <div id="rph_wand_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="Edit where the character and you live">
            <i class="fa-solid fa-house-chimney extensionsMenuExtensionButton"></i>
            <span>Housing</span>
        </div>`);
    button.on('click', () => openEditor());
    $('#extensionsMenu').append(button);
}

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'housing',
        helpString: 'Open the Roleplay Housing editor for the current chat.',
        callback: async () => { openEditor(); return ''; },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'housing-detect',
        helpString: 'Read the character card and persona for housing, merge it into this chat, and open the editor.',
        callback: async () => { await runDetectAndOpen(); return ''; },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'housing-get',
        helpString: 'Return the housing text that is injected into the prompt.',
        returns: 'housing text',
        callback: async () => buildHousingText(),
    }));
}

function registerMacros() {
    const context = ctx();
    const homeFor = owner => () => {
        if (!hasChat()) return '';
        const housing = getHousing();
        const home = housing.homes.find(h => h.owner === owner) ?? housing.homes.find(h => h.owner === 'shared');
        return home ? describeHome(home, settings().includeRooms) : '';
    };
    const defs = [
        ['housing', () => (hasChat() ? buildHousingText() : ''), 'All housing details for this chat (Roleplay Housing).'],
        ['char_home', homeFor('char'), "{{char}}'s home, or the shared home (Roleplay Housing)."],
        ['user_home', homeFor('user'), "{{user}}'s home, or the shared home (Roleplay Housing)."],
    ];
    try {
        // Prefer the new macro engine; fall back to the legacy parser when it is disabled or missing.
        const useNewEngine = typeof context.macros?.register === 'function' && context.powerUserSettings?.experimental_macro_engine !== false;
        for (const [name, handler, description] of defs) {
            if (useNewEngine) context.macros.register(name, { category: 'Roleplay Housing', description, handler });
            else context.registerMacro?.(name, handler, description);
        }
    } catch (error) {
        console.warn('[Roleplay Housing] Could not register macros', error);
    }
}

jQuery(async () => {
    settings();
    await mountSettings();
    mountWandButton();
    registerSlashCommands();
    registerMacros();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        updatePrompt();
        maybeAutoDetect().catch(error => console.error('[Roleplay Housing] Auto-detect failed', error));
    });
    updatePrompt();
});
