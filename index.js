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

const OWNER_ICON = { char: 'fa-masks-theater', user: 'fa-user', shared: 'fa-people-roof' };

const ARRANGEMENT_OPTIONS = [
    { value: 'separate', icon: 'fa-house-user', label: 'Live apart' },
    { value: 'together', icon: 'fa-people-roof', label: 'Live together' },
    { value: 'unspecified', icon: 'fa-circle-question', label: 'Unspecified' },
];

const ROOM_ICONS = [
    [/kitchen|pantry|galley/i, 'fa-utensils'],
    [/dining/i, 'fa-bowl-food'],
    [/bed(room)?|sleep|loft|nursery|chamber|quarters/i, 'fa-bed'],
    [/bath|shower|toilet|wash|lavatory|restroom|privy/i, 'fa-bath'],
    [/living|lounge|sitting|den|family|parlou?r/i, 'fa-couch'],
    [/office|study|library|den|workspace/i, 'fa-book-open'],
    [/garden|yard|greenhouse|grove|glade|courtyard/i, 'fa-seedling'],
    [/garage|carport|stable|barn|shed/i, 'fa-warehouse'],
    [/porch|balcony|terrace|patio|deck|roof/i, 'fa-sun'],
    [/laundry|utility/i, 'fa-shirt'],
    [/hall|entry|foyer|vestibule|corridor|stair/i, 'fa-door-open'],
    [/basement|cellar|attic|storage|closet/i, 'fa-box-archive'],
    [/gym|training|dojo/i, 'fa-dumbbell'],
    [/studio|workshop|forge|lab/i, 'fa-screwdriver-wrench'],
    [/pool|spring|hot tub|sauna/i, 'fa-water-ladder'],
];

function roomIcon(name) {
    return ROOM_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'fa-door-closed';
}

const SOURCE_BADGE = {
    card: '<span class="rph-badge rph-badge-card" title="Filled in from the character card or persona"><i class="fa-solid fa-id-card"></i>from card</span>',
    generated: '<span class="rph-badge rph-badge-gen" title="Designed by the model"><i class="fa-solid fa-wand-magic-sparkles"></i>generated</span>',
    manual: '',
};

function homeMeta(home) {
    const bits = [ownerLabel(home.owner)];
    if (home.type) bits.push(home.type);
    if (home.location) bits.push(home.location);
    return bits.join(' · ');
}

function homeStats(home) {
    const stats = [];
    if (home.rooms.length) stats.push(`<span><i class="fa-solid fa-door-open"></i>${home.rooms.length}</span>`);
    if (home.amenities.length) stats.push(`<span><i class="fa-solid fa-star"></i>${home.amenities.length}</span>`);
    return stats.join('');
}

function renderAvatar(url, owner, label) {
    const fallback = `<div class="rph-avatar rph-avatar-fallback rph-tone-${owner}" title="${escapeHtml(label)}"><i class="fa-solid ${OWNER_ICON[owner]}"></i></div>`;
    if (!url) return fallback;
    return `<img class="rph-avatar rph-tone-${owner}" src="${escapeHtml(url)}" alt="" title="${escapeHtml(label)}" onerror="this.replaceWith(Object.assign(document.createElement('div'), { className: 'rph-avatar rph-avatar-fallback rph-tone-${owner}', innerHTML: '<i class=&quot;fa-solid ${OWNER_ICON[owner]}&quot;></i>' }))" />`;
}

function renderHomeCard(home, ui) {
    const collapsed = ui.collapsed.has(home.id);
    const busy = ui.busy.has(home.id);
    const rooms = home.rooms.map((room, i) => `
        <div class="rph-room" data-index="${i}">
            <div class="rph-room-icon"><i class="fa-solid ${roomIcon(room.name)}"></i></div>
            <input class="text_pole rph-room-name" placeholder="Room" value="${escapeHtml(room.name)}" />
            <input class="text_pole rph-room-details" placeholder="What's in it, how it looks…" value="${escapeHtml(room.details)}" />
            <button type="button" class="rph-icon-btn rph-room-remove" title="Remove room"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');

    const chips = home.amenities.map((amenity, i) => `
        <span class="rph-chip" data-index="${i}">${escapeHtml(amenity)}<button type="button" class="rph-chip-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button></span>`).join('');

    return `
    <section class="rph-home rph-tone-${home.owner}${collapsed ? ' rph-collapsed' : ''}${busy ? ' rph-busy' : ''}" data-id="${escapeHtml(home.id)}">
        <header class="rph-home-head">
            <div class="rph-home-icon"><i class="fa-solid ${OWNER_ICON[home.owner]}"></i></div>
            <div class="rph-home-title">
                <div class="rph-home-name">${escapeHtml(home.name || 'Untitled home')}</div>
                <div class="rph-home-meta">${escapeHtml(homeMeta(home))}</div>
            </div>
            <div class="rph-home-stats">${homeStats(home)}</div>
            ${SOURCE_BADGE[home.source] ?? ''}
            <button type="button" class="rph-icon-btn rph-home-remove" title="Delete this home"><i class="fa-solid fa-trash-can"></i></button>
            <button type="button" class="rph-icon-btn rph-home-toggle" title="${collapsed ? 'Expand' : 'Collapse'}"><i class="fa-solid fa-chevron-down"></i></button>
        </header>
        <div class="rph-home-body">
            <div class="rph-grid">
                <label class="rph-field-wrap">
                    <span class="rph-label">Belongs to</span>
                    <select class="text_pole rph-owner">
                        ${OWNERS.map(o => `<option value="${o}" ${o === home.owner ? 'selected' : ''}>${escapeHtml(ownerLabel(o))}</option>`).join('')}
                    </select>
                </label>
                <label class="rph-field-wrap">
                    <span class="rph-label">Name</span>
                    <input class="text_pole rph-field" data-field="name" placeholder="The Harbor Street Apartment" value="${escapeHtml(home.name)}" />
                </label>
                <label class="rph-field-wrap">
                    <span class="rph-label">Type</span>
                    <input class="text_pole rph-field" data-field="type" placeholder="Cramped studio, castle, dorm room…" value="${escapeHtml(home.type)}" />
                </label>
                <label class="rph-field-wrap">
                    <span class="rph-label">Location</span>
                    <input class="text_pole rph-field" data-field="location" placeholder="City, neighbourhood, world location…" value="${escapeHtml(home.location)}" />
                </label>
                <label class="rph-field-wrap rph-span">
                    <span class="rph-label">Description</span>
                    <textarea class="text_pole rph-field" data-field="description" rows="3" placeholder="How it looks and feels, what condition it's in…">${escapeHtml(home.description)}</textarea>
                </label>
            </div>

            <div class="rph-subhead"><i class="fa-solid fa-table-cells-large"></i>Layout</div>
            <div class="rph-rooms">${rooms || '<div class="rph-hint">No rooms yet. Add them yourself or use <b>Flesh out</b> below.</div>'}</div>
            <button type="button" class="rph-ghost-btn rph-room-add"><i class="fa-solid fa-plus"></i>Add room</button>

            <div class="rph-subhead"><i class="fa-solid fa-star"></i>Amenities</div>
            <div class="rph-chips">
                ${chips}
                <input class="rph-chip-input" placeholder="${home.amenities.length ? 'Add more…' : 'Fireplace, rooftop access, washer/dryer…'}" title="Press Enter or comma to add" />
            </div>

            <label class="rph-field-wrap">
                <span class="rph-subhead"><i class="fa-solid fa-note-sticky"></i>Notes</span>
                <textarea class="text_pole rph-field" data-field="notes" rows="2" placeholder="Rent, ownership, neighbours, quirks…">${escapeHtml(home.notes)}</textarea>
            </label>

            <div class="rph-magic">
                <i class="fa-solid fa-wand-magic-sparkles rph-magic-icon"></i>
                <input class="rph-brief" placeholder="Describe it in a sentence, e.g. “a cozy rundown farmhouse with a big porch”" />
                <button type="button" class="menu_button rph-generate-btn" title="Let the model add layout and amenities. Nothing you've written is replaced.">Flesh out</button>
            </div>
        </div>
        <div class="rph-busy-overlay"><i class="fa-solid fa-spinner fa-spin-pulse"></i><span>Designing the home…</span></div>
    </section>`;
}

function renderEmpty() {
    return `
    <div class="rph-empty-state">
        <div class="rph-empty-icon"><i class="fa-solid fa-house-chimney-window"></i></div>
        <div class="rph-empty-title">No housing yet</div>
        <div class="rph-empty-text">Read it from ${escapeHtml(charName())}'s card, or add a home and describe it yourself.</div>
        <div class="rph-empty-actions">
            <button type="button" class="menu_button rph-detect"><i class="fa-solid fa-id-card"></i>Read from card</button>
            <button type="button" class="menu_button rph-add" data-owner="char"><i class="fa-solid fa-plus"></i>${escapeHtml(charName())}'s home</button>
            <button type="button" class="menu_button rph-add" data-owner="user"><i class="fa-solid fa-plus"></i>${escapeHtml(userName())}'s home</button>
        </div>
    </div>`;
}

function renderEditor(state, ui) {
    const arrangement = ARRANGEMENT_OPTIONS.map(o => `
        <button type="button" class="rph-seg${state.arrangement === o.value ? ' rph-seg-active' : ''}" data-value="${o.value}">
            <i class="fa-solid ${o.icon}"></i><span>${o.label}</span>
        </button>`).join('');

    return `
    <div class="rph-editor">
        <div class="rph-hero">
            <div class="rph-avatars">
                ${renderAvatar(ui.charAvatar, 'char', charName())}
                <div class="rph-avatar-link"><i class="fa-solid ${state.arrangement === 'together' ? 'fa-house-chimney' : state.arrangement === 'separate' ? 'fa-arrows-left-right' : 'fa-ellipsis'}"></i></div>
                ${renderAvatar(ui.userAvatar, 'user', userName())}
            </div>
            <div class="rph-hero-text">
                <div class="rph-title">Housing</div>
                <div class="rph-subtitle">Where <b>${escapeHtml(charName())}</b> and <b>${escapeHtml(userName())}</b> live · saved to this chat</div>
            </div>
        </div>

        <div class="rph-bar">
            <div class="rph-segmented" role="radiogroup" aria-label="Living arrangement">${arrangement}</div>
            <div class="rph-bar-actions">
                <button type="button" class="rph-ghost-btn rph-add" data-owner="char"><i class="fa-solid fa-plus"></i>${escapeHtml(charName())}</button>
                <button type="button" class="rph-ghost-btn rph-add" data-owner="user"><i class="fa-solid fa-plus"></i>${escapeHtml(userName())}</button>
                <button type="button" class="rph-ghost-btn rph-add" data-owner="shared"><i class="fa-solid fa-plus"></i>Shared</button>
                <button type="button" class="rph-ghost-btn rph-detect" title="Read the character card and persona for housing"><i class="fa-solid fa-id-card"></i>Read card</button>
            </div>
        </div>

        <div class="rph-homes">${state.homes.length ? state.homes.map(h => renderHomeCard(h, ui)).join('') : renderEmpty()}</div>

        <label class="rph-field-wrap rph-notes-wrap">
            <span class="rph-subhead"><i class="fa-solid fa-map-location-dot"></i>Other housing notes</span>
            <textarea class="text_pole rph-notes" rows="2" placeholder="Anything else the model should know: they're house-hunting, one of them is crashing on the other's couch…">${escapeHtml(state.notes)}</textarea>
        </label>

        <details class="rph-preview"${ui.previewOpen ? ' open' : ''}>
            <summary><i class="fa-solid fa-eye"></i>What the model sees <span class="rph-preview-size"></span></summary>
            <pre class="rph-preview-text"></pre>
        </details>
    </div>`;
}

async function personaAvatarUrl() {
    try {
        const { user_avatar } = await import('/scripts/personas.js');
        return user_avatar ? ctx().getThumbnailUrl('persona', user_avatar) : '';
    } catch {
        return '';
    }
}

async function openEditor() {
    const context = ctx();
    if (!hasChat()) {
        toastr.warning('Open a chat first — housing is saved per chat.', 'Roleplay Housing');
        return;
    }

    let state = structuredClone(getHousing());
    const character = context.characters?.[context.characterId];
    const ui = {
        collapsed: new Set(),
        busy: new Set(),
        previewOpen: false,
        charAvatar: character?.avatar && character.avatar !== 'none' ? context.getThumbnailUrl('avatar', character.avatar) : '',
        userAvatar: await personaAvatarUrl(),
    };
    const root = $('<div class="rph-root"></div>');

    const cardOf = el => $(el).closest('.rph-home');
    const findHome = el => state.homes.find(h => h.id === cardOf(el).data('id'));
    const refreshPreview = () => {
        const text = buildHousingText(state);
        root.find('.rph-preview-text').text(text || '(nothing yet — housing is empty)');
        root.find('.rph-preview-size').text(text ? `≈ ${Math.ceil(text.length / 4)} tokens` : '');
    };
    const refreshHead = el => {
        const home = findHome(el);
        if (!home) return;
        const card = cardOf(el);
        card.find('.rph-home-name').text(home.name || 'Untitled home');
        card.find('.rph-home-meta').text(homeMeta(home));
        card.find('.rph-home-stats').html(homeStats(home));
    };
    const rerender = () => {
        const scroll = root.closest('.popup-content').scrollTop();
        root.html(renderEditor(state, ui));
        refreshPreview();
        root.closest('.popup-content').scrollTop(scroll);
    };
    // Adds chips in place (no rerender) so typing and focus are never interrupted.
    const addAmenities = input => {
        const home = findHome(input);
        const items = normalizeList(input.value).filter(item => !home?.amenities.includes(item));
        input.value = '';
        if (!home || !items.length) return;
        for (const item of items) {
            home.amenities.push(item);
            $(input).before(`<span class="rph-chip" data-index="${home.amenities.length - 1}">${escapeHtml(item)}<button type="button" class="rph-chip-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button></span>`);
        }
        input.placeholder = 'Add more…';
        refreshHead(input);
        refreshPreview();
    };

    root.on('click', '.rph-seg', e => { state.arrangement = e.currentTarget.dataset.value; rerender(); });
    root.on('input', '.rph-notes', e => { state.notes = e.target.value; refreshPreview(); });
    root.on('toggle', '.rph-preview', e => { ui.previewOpen = e.currentTarget.open; });
    root.on('input', '.rph-field', e => {
        const home = findHome(e.target);
        if (home) home[e.target.dataset.field] = e.target.value;
        refreshHead(e.target);
        refreshPreview();
    });
    root.on('change', '.rph-owner', e => {
        const home = findHome(e.target);
        if (home) home.owner = e.target.value;
        rerender();
    });
    root.on('click', '.rph-home-head', e => {
        if ($(e.target).closest('.rph-home-remove').length) return;
        const id = cardOf(e.currentTarget).data('id');
        if (ui.collapsed.has(id)) ui.collapsed.delete(id); else ui.collapsed.add(id);
        cardOf(e.currentTarget).toggleClass('rph-collapsed', ui.collapsed.has(id));
    });
    root.on('input', '.rph-room-name, .rph-room-details', e => {
        const home = findHome(e.target);
        const row = $(e.target).closest('.rph-room');
        const index = Number(row.data('index'));
        if (!home?.rooms[index]) return;
        const isName = $(e.target).hasClass('rph-room-name');
        home.rooms[index][isName ? 'name' : 'details'] = e.target.value;
        if (isName) row.find('.rph-room-icon i').attr('class', `fa-solid ${roomIcon(e.target.value)}`);
        refreshPreview();
    });
    root.on('change', '.rph-room-name', e => refreshHead(e.target));
    root.on('click', '.rph-room-add', e => {
        const home = findHome(e.currentTarget);
        if (!home) return;
        home.rooms.push({ name: '', details: '' });
        rerender();
        root.find(`.rph-home[data-id="${home.id}"] .rph-room-name`).last().trigger('focus');
    });
    root.on('click', '.rph-room-remove', e => {
        findHome(e.currentTarget)?.rooms.splice(Number($(e.currentTarget).closest('.rph-room').data('index')), 1);
        rerender();
    });
    root.on('click', '.rph-chips', e => {
        if (e.target === e.currentTarget) $(e.currentTarget).find('.rph-chip-input').trigger('focus');
    });
    root.on('keydown', '.rph-chip-input', e => {
        const input = e.currentTarget;
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addAmenities(input);
        } else if (e.key === 'Backspace' && !input.value) {
            const home = findHome(input);
            if (!home?.amenities.length) return;
            home.amenities.pop();
            $(input).prev('.rph-chip').remove();
            refreshHead(input);
            refreshPreview();
        }
    });
    root.on('blur', '.rph-chip-input', e => addAmenities(e.currentTarget));
    root.on('click', '.rph-chip-remove', e => {
        findHome(e.currentTarget)?.amenities.splice(Number($(e.currentTarget).closest('.rph-chip').data('index')), 1);
        rerender();
    });
    root.on('click', '.rph-add', e => {
        const home = emptyHome(e.currentTarget.dataset.owner);
        state.homes.push(home);
        if (home.owner === 'shared') state.arrangement = 'together';
        rerender();
        const card = root.find(`.rph-home[data-id="${home.id}"]`);
        card[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.find('[data-field=name]').trigger('focus');
    });
    root.on('click', '.rph-home-remove', async e => {
        e.stopPropagation();
        const home = findHome(e.currentTarget);
        if (!home) return;
        const hasContent = home.name || home.description || home.rooms.length || home.amenities.length;
        if (hasContent) {
            const confirmed = await ctx().callGenericPopup(`Delete <b>${escapeHtml(home.name || ownerLabel(home.owner))}</b>?`, ctx().POPUP_TYPE.CONFIRM);
            if (confirmed !== ctx().POPUP_RESULT.AFFIRMATIVE) return;
        }
        state.homes = state.homes.filter(h => h !== home);
        rerender();
    });
    root.on('click', '.rph-detect', async e => {
        const button = $(e.currentTarget).addClass('rph-loading');
        try {
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
        } finally {
            button.removeClass('rph-loading');
        }
    });
    root.on('keydown', '.rph-brief', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            $(e.currentTarget).closest('.rph-magic').find('.rph-generate-btn').trigger('click');
        }
    });
    root.on('click', '.rph-generate-btn', async e => {
        const home = findHome(e.currentTarget);
        if (!home || ui.busy.has(home.id)) return;
        const brief = String(cardOf(e.currentTarget).find('.rph-brief').val() ?? '').trim();
        ui.busy.add(home.id);
        cardOf(e.currentTarget).addClass('rph-busy');
        try {
            const result = await generateHome(normalizeHome(home), brief);
            if (result) state.homes = state.homes.map(h => (h.id === home.id ? result : h));
        } finally {
            ui.busy.delete(home.id);
            rerender();
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
        syncDepthState();
    };
    // Depth and role only matter when injecting into the chat history.
    const syncDepthState = () => {
        const inChat = Number(settings().position) === 1;
        $('#rph_depth, #rph_role').prop('disabled', !inChat).closest('div').css('opacity', inChat ? '' : '0.5');
    };
    load();

    $('#rph_open').on('click', () => openEditor());
    $('#rph_enabled').on('change', e => { settings().enabled = e.target.checked; save(); });
    $('#rph_auto_detect').on('change', e => { settings().autoDetect = e.target.value; save(); });
    $('#rph_position').on('change', e => { settings().position = Number(e.target.value); syncDepthState(); save(); });
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
