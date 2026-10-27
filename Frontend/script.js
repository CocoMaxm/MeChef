'use strict';
/* =====================================================================
   MyMealChef website
   Sections: 1 helpers · 2 session & navigation · 3 browsing chefs ·
             4 sign-up / login · 5 booking (calendar + time slots) ·
             6 customer dashboard · 7 chef dashboard · 8 admin · 9 start-up
   All text coming from the server is escaped with esc() before it is put in the page.
   ===================================================================== */

const FALLBACK_COUNTRY = {
    code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timezone: 'Africa/Nairobi', decimals: 0,
    regionLabel: 'County', regionRequired: false, postalLabel: 'Postal code', postalRequired: false,
    minHourlyRate: 500, dialCode: '+254'
};

const INTERVIEW_QUESTIONS = [
    'Why do you want to cook for clients in their own homes?',
    'Describe a dish you are proud of and how you would prepare it for a group of guests.',
    "How do you keep food safe and the kitchen clean when cooking in a client's home?"
];

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MAX_MONTHS_AHEAD = 6;

// Bumped on every login/logout. A slow response that arrives after the person logged out (or another person logged in)
// is thrown away instead of being drawn onto the page.
let sessionId = 0;

const state = {
    user: null, chef: null, application: null,
    countries: [], countryCode: localStorage.getItem('country') || 'KE',
    chefs: [], cuisine: null, chefSearchCity: '', chefSearchActive: false, homeOrderSearch: null,
    booking: null,
    reasonCodes: [],
    myBookings: [], chefBookings: [], timeOff: [],
    meta: null, kitchens: [], currentKitchen: null, cart: { chefId: null, items: {} }, myOrders: [], chefOrders: [], kitchenSettings: null, meals: [],
    adminChefs: [], savedItems: null, discoveryObserver: null,
    chefCal: { year: null, month: null }
};

/* ------------------------------ 1. helpers ------------------------------ */
const $ = (id) => document.getElementById(id);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const getCountry = (code) => {
    const wanted = String(code || state.countryCode || 'KE').toUpperCase();
    return state.countries.find((c) => c.code === wanted) || FALLBACK_COUNTRY;
};

function money(amount, c) {
    const k = c || getCountry();
    try {
        return new Intl.NumberFormat(k.locale, {
            style: 'currency', currency: k.currency,
            minimumFractionDigits: k.decimals, maximumFractionDigits: k.decimals
        }).format(amount);
    } catch (e) { return `${k.currency} ${amount}`; }
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m0, d) => `${y}-${pad(m0 + 1)}-${pad(d)}`; // m0 = 0-based month. No Date/ISO conversion, so no time-zone off-by-one.

function todayIn(timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}
const fmtDate = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDay = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtDateTime = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));
const dateKey = (iso) => String(iso).slice(0, 10);

function time12(hhmm) {
    if (!hhmm) return '';
    const [h, m] = String(hhmm).split(':').map(Number);
    return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
const minToHHMM = (m) => (m >= 1440 ? '24:00' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
const endOf = (startHHMM, hours) => {
    const [h, m] = startHHMM.split(':').map(Number);
    return minToHHMM(h * 60 + m + hours * 60);
};

let loaders = 0;
const showLoader = () => { loaders++; $('loadingSpinner').classList.add('show'); };
const hideLoader = () => { loaders = Math.max(0, loaders - 1); if (!loaders) $('loadingSpinner').classList.remove('show'); };

function notify(message, type = 'success') {
    const box = $('toastBox');
    if (!box || !window.bootstrap) { alert(message); return; }
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type} border-0`;
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div class="d-flex"><div class="toast-body"></div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>';
    el.querySelector('.toast-body').textContent = message;
    box.appendChild(el);
    el.addEventListener('hidden.bs.toast', () => el.remove());
    new bootstrap.Toast(el, { delay: type === 'danger' ? 7000 : 4000 }).show();
}

// Runs an API call with the spinner and error toast. Returns undefined when it failed.
async function guard(fn, { quiet = false, onError } = {}) {
    if (!quiet) showLoader();
    try {
        return await fn();
    } catch (err) {
        if (err.code === 'EMAIL_NOT_VERIFIED') refreshMe(); // maybe they just confirmed it in another tab
        const handled = onError ? await onError(err) : false;
        if (handled !== true) notify(err.message || 'Something went wrong', 'danger');
        return undefined;
    } finally {
        if (!quiet) hideLoader();
    }
}

const modal = (id) => bootstrap.Modal.getOrCreateInstance($(id));
const hideModal = (id) => { const m = bootstrap.Modal.getInstance($(id)); if (m) m.hide(); };

const statusBadge = (status) => {
    const map = { pending: 'warning text-dark', confirmed: 'success', rejected: 'danger', cancelled: 'secondary', completed: 'info text-dark', 'in-progress': 'primary' };
    const label = { pending: 'Waiting for the chef', confirmed: 'Confirmed', rejected: 'Declined', cancelled: 'Cancelled', completed: 'Completed', 'in-progress': 'In progress' };
    return `<span class="badge bg-${map[status] || 'secondary'}">${esc(label[status] || status)}</span>`;
};
const reasonLabel = (code) => (state.reasonCodes.find((r) => r.code === code) || {}).label || code || '';

function stars(n) {
    const full = Math.round(n || 0);
    return '<span class="chef-rating">' + '<i class="fas fa-star"></i>'.repeat(full) + '<i class="far fa-star"></i>'.repeat(Math.max(0, 5 - full)) + '</span>';
}

// Photo links from the server are paths like /api/photos/meals/<id>; make them absolute for the API's address.
const imgSrc = (path) => (path ? `${API_BASE_URL.replace(/\/api$/, '')}${path}` : '');

function mealPhotoHtml(m) {
    if (!m.thumb) return '<div class="meal-photo meal-photo-empty"><i class="fas fa-utensils"></i></div>';
    return `<button type="button" class="meal-photo-btn" data-action="viewPhoto" data-src="${esc(imgSrc(m.photo))}" data-caption="${esc(m.name)}" aria-label="Enlarge photo of ${esc(m.name)}"><img class="meal-photo" src="${esc(imgSrc(m.thumb))}" alt="${esc(m.name)}" loading="lazy"></button>`;
}

function buildPhone(dial, raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (String(raw || '').trim().startsWith('+')) return `+${digits}`;
    return `${dial}${digits.replace(/^0+/, '')}`;
}

/* ------------------------ 2. session & navigation ----------------------- */
function setSession(token, user) { sessionId++; localStorage.setItem('authToken', token); state.user = user; }

// Wipe everything the previous user could see, so nothing leaks to the next person on this device
function resetViews() {
    ['applicationPanel', 'bookingsList', 'profilePanel', 'timeOffList', 'chefCalendar', 'timeOffWarnings',
     'myBookingsList', 'adminChefList', 'weekdayChecks', 'chefTimeOffInfo', 'myOrdersList', 'chefOrdersList', 'kitchenPanel',
     'chefStoriesPanel', 'savedChefsList', 'savedDishesList'].forEach((id) => { const el = $(id); if (el) el.innerHTML = ''; });
    if (state.discoveryObserver) state.discoveryObserver.disconnect();
    $('pendingCount').style.display = 'none';
    $('pendingOrdersCount').style.display = 'none';
    $('activeOrdersCount').style.display = 'none';
    $('chefStatusBadge').textContent = '';
    $('chefName').textContent = '';
}

function clearSession() {
    sessionId++;
    localStorage.removeItem('authToken');
    Object.assign(state, { user: null, chef: null, application: null, myBookings: [], chefBookings: [], timeOff: [], adminChefs: [], booking: null,
        myOrders: [], chefOrders: [], kitchenSettings: null, meals: [], cart: { chefId: null, items: {} }, chefCal: { year: null, month: null } });
    resetViews();
}

async function restoreSession() {
    if (!localStorage.getItem('authToken')) return;
    try {
        const r = await api.auth.me();
        state.user = r.user;
        state.chef = r.chef || null;
    } catch (e) { clearSession(); }
}

function logout() {
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    clearSession();
    renderNav();
    notify('You have been logged out.', 'info');
    showPage('homePage');
}
window.addEventListener('auth-expired', () => {
    clearSession(); renderNav();
    notify('Your session expired. Please log in again.', 'warning');
    showPage('customerAuthPage');
});

// The reminder bar: shown while a logged-in person's email is still unconfirmed
function renderVerifyBanner() {
    const show = !!state.user && state.user.emailVerified === false;
    $('verifyBanner').style.display = show ? 'flex' : 'none';
    if (show) $('verifyBannerEmail').textContent = state.user.email;
}

async function refreshMe() {
    if (!state.user) return;
    try {
        const r = await api.auth.me();
        state.user = r.user;
        renderNav();
    } catch (e) { /* keep the current state */ }
}

// True when the email is confirmed. If not, re-checks once (the person may have clicked the link in another tab).
async function ensureVerified() {
    if (!state.user) return false;
    if (state.user.emailVerified) return true;
    await refreshMe();
    if (state.user && state.user.emailVerified) return true;
    notify('Please confirm your email address first. We sent you a link: check your inbox (and spam folder).', 'warning');
    return false;
}

async function resendVerification() {
    const r = await guard(() => api.auth.resendVerification());
    if (!r) return;
    if (r.alreadyVerified) await refreshMe();
    notify(r.message, 'info');
}

function renderNav() {
    renderVerifyBanner();
    const el = $('navAuth');
    const u = state.user;
    if (!u) {
        el.innerHTML = '<a class="btn btn-sm nav-auth-cta" href="#" data-action="goPage" data-page="customerAuthPage">Log in / Sign up</a>';
        return;
    }
    const target = { customer: ['myBookingsPage', 'My Bookings'], chef: ['extranetPage', 'My Dashboard'], admin: ['adminPage', 'Admin'] }[u.role];
    el.innerHTML = `<span class="small text-muted me-2">Hi, ${esc(u.firstName)}</span>
        <a class="btn btn-sm btn-outline-primary me-1" href="#" data-action="goPage" data-page="${target[0]}">${target[1]}</a>
        <a class="btn btn-sm btn-outline-secondary" href="#" data-action="logout">Logout</a>`;
}

function renderCountrySelects() {
    document.querySelectorAll('.js-country-select').forEach((sel) => {
        sel.innerHTML = state.countries.map((c) => `<option value="${esc(c.code)}">${esc(c.name)} (${esc(c.currency)})</option>`).join('');
        sel.value = state.countryCode;
    });
    const signup = $('signupCountry');
    signup.innerHTML = state.countries.map((c) => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('');
    signup.value = state.countryCode;
    updateSignupCountryUI();
}

function setCountry(code) {
    state.countryCode = code;
    localStorage.setItem('country', code);
    document.querySelectorAll('.js-country-select').forEach((s) => { s.value = code; });
    if ($('cuisinesPage').style.display === 'block') {
        loadCuisineStats();
        if (state.chefSearchActive) showChefs(state.cuisine, state.chefSearchCity);
    }
    if ($('orderFoodPage').style.display === 'block') searchKitchens();
    if ($('homePage').style.display === 'block') loadFeaturedChefs();
    if ($('discoveryPage').style.display === 'block') { if ($('discoveryChef')) $('discoveryChef').dataset.loaded = 'false'; loadDiscoveryOptions(); loadDiscoveryFeed(); }
}

// Is the logged-in user of the right kind? If not, send them to log in.
function requireRole(role) {
    if (!state.user) {
        notify('Please log in first.', 'info');
        showPage('customerAuthPage');
        return false;
    }
    if (state.user.role !== role) {
        notify(`This page is for ${role} accounts.`, 'warning');
        return false;
    }
    return true;
}

function showPage(pageId) {
    if (state.discoveryObserver) { state.discoveryObserver.disconnect(); document.querySelectorAll('.page video').forEach((video) => video.pause()); }
    document.querySelectorAll('.page').forEach((p) => { p.style.display = 'none'; });
    $(pageId).style.display = 'block';
    window.scrollTo(0, 0);
    const nav = $('navbarNav');
    if (nav && nav.classList.contains('show') && window.bootstrap) bootstrap.Collapse.getOrCreateInstance(nav).hide();

    if (pageId === 'cuisinesPage') loadCuisineStats();
    if (pageId === 'homePage') loadFeaturedChefs();
    if (pageId === 'orderFoodPage') loadOrderFoodPage();
    if (pageId === 'myBookingsPage' && requireRole('customer')) loadMyBookings();
    if (pageId === 'extranetPage') renderExtranet();
    if (pageId === 'adminPage' && requireRole('admin')) loadAdminPage();
    if (pageId === 'discoveryPage') { loadDiscoveryOptions(); const postId = state.openPostId; state.openPostId = null; loadDiscoveryFeed(postId ? {} : discoveryParams(), postId || ''); }
    if (pageId === 'myBookingsPage' && state.user?.role === 'customer') loadSavedItems();
}

/* ---------------------------- 3. browsing chefs --------------------------- */
async function loadCuisineStats() {
    const c = getCountry();
    try {
        const r = await api.cuisines.getAll({ country: c.code });
        const byName = Object.fromEntries(r.data.map((x) => [x.name.toLowerCase(), x]));
        document.querySelectorAll('.cuisine-card').forEach((card) => {
            const m = (card.getAttribute('onclick') || '').match(/showChefs\('([^']+)'\)/);
            const label = card.querySelector('small');
            if (!m || !label) return;
            const info = byName[m[1].toLowerCase()];
            label.textContent = info ? `${info.chefCount} chef${info.chefCount === 1 ? '' : 's'} in ${c.name}` : `Explore chefs in ${c.name}`;
        });
    } catch (e) { /* keep the default text */ }
}

async function showChefs(cuisine, city = '') {
    const selectedCuisine = String(cuisine || '').trim();
    const selectedCity = String(city || '').trim();
    state.cuisine = selectedCuisine || null;
    state.chefSearchCity = selectedCity;
    state.chefSearchActive = true;
    const c = getCountry();
    showPage('cuisinesPage');
    document.querySelector('#cuisinesPage section.container').style.display = 'none';
    $('chefDisplaySection').style.display = 'block';
    $('selectedCuisineTitle').textContent = `${selectedCuisine ? `${selectedCuisine} chefs` : 'Personal chefs'} in ${selectedCity || c.name}`;
    $('chefsList').innerHTML = '<div class="text-center text-muted py-5">Loading chefs…</div>';
    $('cuisinePostSection').style.display = 'block'; $('cuisinePostTitle').textContent = selectedCuisine || 'all cuisines';
    const postFilters = { country: c.code, ...(selectedCuisine ? { cuisine: selectedCuisine } : {}) };
    api.discovery.posts(postFilters).then((posts) => {
        $('cuisinePostFeed').innerHTML = posts.data.length ? posts.data.map(postMarkup).join('') : '<div class="text-muted">No cooking stories in this cuisine yet.</div>';
        observeStoryVideos($('cuisinePostFeed'));
    }).catch(() => { $('cuisinePostFeed').innerHTML = '<div class="text-muted">Stories could not be loaded.</div>'; });
    const r = await guard(() => api.chefs.getAll({ cuisine: selectedCuisine, city: selectedCity, country: c.code }));
    state.chefs = r ? r.data : [];
    displayChefs();
}

function hideChefs() {
    state.cuisine = null;
    state.chefSearchCity = '';
    state.chefSearchActive = false;
    document.querySelector('#cuisinesPage section.container').style.display = 'block';
    $('chefDisplaySection').style.display = 'none';
    $('cuisinePostSection').style.display = 'none';
}

let homeSearchMode = 'chef';
function setHomeSearchMode(mode) {
    if (!['chef', 'meal'].includes(mode)) return;
    homeSearchMode = mode;
    document.querySelectorAll('.home-search-mode').forEach((button) => {
        const selected = button.dataset.mode === mode;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    $('homeSearchForm').querySelector('.home-search-submit span').textContent = mode === 'chef' ? 'Find a chef' : 'Find meals';
    $('homeSearchCity').placeholder = mode === 'chef' ? 'Where should your chef cook?' : 'Where should we look?';
    document.querySelector('.home-search-note-chef').hidden = mode !== 'chef';
    document.querySelector('.home-search-note-meal').hidden = mode !== 'meal';
}

async function submitHomeSearch() {
    const city = $('homeSearchCity').value.trim();
    const cuisine = $('homeSearchCuisine').value;
    if (homeSearchMode === 'meal') {
        state.homeOrderSearch = { city, cuisine };
        showPage('orderFoodPage');
        return;
    }
    await showChefs(cuisine, city);
}

function displayChefs() {
    const list = $('chefsList');
    if (!state.chefs.length) {
        const searchSummary = [state.cuisine ? `${state.cuisine} chefs` : 'chefs', `in ${state.chefSearchCity || getCountry().name}`].join(' ');
        list.innerHTML = `<div class="col-12"><div class="alert alert-light border">No ${esc(searchSummary)} are available yet. Try another cuisine or location.</div></div>`;
        return;
    }
    list.innerHTML = state.chefs.map((chef) => {
        const c = getCountry(chef.serviceLocation && chef.serviceLocation.country);
        const u = chef.user || {};
        const loc = [chef.serviceLocation.city, chef.serviceLocation.state].filter(Boolean).join(', ');
        const rating = chef.rating && chef.rating.count
            ? `<span class="chef-rating">${stars(chef.rating.average)}</span> <small class="text-muted">${esc(chef.rating.average)} (${esc(chef.rating.count)} reviews)</small>`
            : '<small class="text-muted">New chef</small>';
        const specialties = [chef.cuisineSpecialization, ...(chef.additionalCuisines || [])].filter(Boolean).map(esc).join(' · ');
        const photo = chef.profileImage ? `<img src="${esc(chef.profileImage)}" alt="Chef ${esc(u.firstName)}" class="discovery-chef-photo" loading="lazy">` : `<div class="discovery-chef-initial">${esc((u.firstName || 'C').charAt(0).toUpperCase())}</div>`;
        const signatureDishes = (chef.signatureDishes || []).slice(0, 3);
        return `<div class="col-lg-6"><article class="chef-card discovery-chef-card">
            <div class="discovery-chef-top">${photo}<div class="flex-grow-1"><div class="discovery-chef-specialty">${specialties}</div><h3>${esc(u.firstName)} ${esc(u.lastName)}</h3><div class="mb-2">${rating}</div><p class="mb-0 text-muted small"><i class="fas fa-location-dot me-1"></i>${esc(loc)} <span class="mx-1">·</span> ${esc(chef.experience)} years experience</p></div></div>
            <p class="discovery-chef-bio">${esc(chef.bio)}</p>
            <div class="discovery-chef-menu"><i class="fas fa-wand-magic-sparkles"></i><span>${signatureDishes.length ? `<strong>Signature dishes:</strong> ${signatureDishes.map(esc).join(' · ')}` : 'Custom menus welcome — share your favourite dishes with your chef.'}</span></div>
            <div class="discovery-chef-footer"><strong>${esc(money(chef.hourlyRate, c))}<small> / hour</small></strong><div class="d-flex gap-2"><button class="btn btn-outline-primary btn-sm" data-action="openChefProfile" data-id="${esc(chef._id)}">Meet chef</button><button class="btn btn-primary btn-sm" data-action="bookChef" data-id="${esc(chef._id)}">Book <i class="fas fa-arrow-right ms-1"></i></button></div></div>
        </article></div>`;
    }).join('');
}

async function loadFeaturedChefs() {
    const grid = $('homeChefCards');
    if (!grid) return;
    grid.innerHTML = '<div class="chef-loading"><span class="spinner-border spinner-border-sm me-2"></span>Finding chefs near you…</div>';
    try {
        const r = await api.chefs.getAll({ country: getCountry().code, sortBy: 'rating' });
        const chefs = r.data.slice(0, 3);
        if (!chefs.length) {
            grid.innerHTML = `<div class="chef-empty"><i class="fas fa-utensils mb-2"></i><div>Chef profiles for ${esc(getCountry().name)} are coming soon.</div><small>Explore cuisines or check another location.</small></div>`;
            return;
        }
        grid.innerHTML = chefs.map((chef) => {
            const u = chef.user || {};
            const country = getCountry(chef.serviceLocation && chef.serviceLocation.country);
            const name = `${u.firstName || 'Chef'} ${u.lastName || ''}`.trim();
            const initials = `${(u.firstName || 'C').charAt(0)}${(u.lastName || '').charAt(0)}`.toUpperCase();
            const specialties = [chef.cuisineSpecialization, ...(chef.additionalCuisines || [])].filter(Boolean);
            const rating = chef.rating && chef.rating.count
                ? `<span><i class="fas fa-star"></i> ${esc(chef.rating.average)}</span> <small>(${esc(chef.rating.count)} reviews)</small>`
                : '<small>New chef</small>';
            const dishes = (chef.signatureDishes || []).slice(0, 2);
            const photo = chef.profileImage
                ? `<img src="${esc(chef.profileImage)}" alt="${esc(name)}" loading="lazy">`
                : `<div class="home-chef-initial" aria-label="${esc(name)}">${esc(initials)}</div>`;
            return `<article class="home-chef-card"><div class="home-chef-photo">${photo}<span class="home-chef-verified"><i class="fas fa-circle-check"></i> Verified chef</span></div>
                <div class="home-chef-body"><div class="home-chef-top"><div><h3>${esc(name)}</h3><div class="home-chef-specialty">${esc(specialties.slice(0, 2).join(' · '))}</div></div><div class="home-chef-rating">${rating}</div></div>
                <p class="home-chef-bio">${esc(chef.bio || 'A professional chef ready to create a personal dining experience in your space.')}</p>
                ${dishes.length ? `<div class="home-chef-dishes"><i class="fas fa-utensils"></i><span>${dishes.map(esc).join(' · ')}</span></div>` : ''}
                <div class="home-chef-meta"><span><i class="fas fa-location-dot"></i>${esc(chef.serviceLocation?.city || country.name)}</span><span><i class="fas fa-briefcase"></i>${esc(chef.experience)} years</span><span><i class="fas fa-house"></i>Cooks at your place</span></div>
                <div class="home-chef-bottom"><div class="home-chef-price">${esc(money(chef.hourlyRate, country))}<small> / hour</small></div><button class="btn btn-primary home-chef-book" data-action="openChefProfile" data-id="${esc(chef._id)}">Meet ${esc(u.firstName || 'chef')} <i class="fas fa-arrow-right ms-1"></i></button></div></div></article>`;
        }).join('');
    } catch (e) {
        grid.innerHTML = '<div class="chef-empty">Chef profiles could not be loaded right now. Please try again in a moment.</div>';
    }
}

/* -------------------------- Google sign-in (optional) -------------------------- */
// Only active when the server has GOOGLE_CLIENT_ID set; otherwise the buttons stay hidden.
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src; el.async = true; el.defer = true;
        el.onload = resolve; el.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(el);
    });
}

async function initGoogle() {
    try {
        const cfg = await api.config.get();
        if (!cfg.googleClientId) return;
        await loadScript('https://accounts.google.com/gsi/client');
        if (!window.google || !google.accounts || !google.accounts.id) return;
        google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogleCredential, auto_select: false, cancel_on_tap_outside: true });
        document.querySelectorAll('.google-box').forEach((box) => { box.style.display = 'block'; });
        ['googleBtnCustomer', 'googleBtnChef'].forEach((id) => {
            google.accounts.id.renderButton($(id), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
        });
    } catch (e) { /* no Google button: email and password still work */ }
}

// Google calls this with the signed-in person's credential (an ID token the SERVER verifies)
async function onGoogleCredential(response) {
    state.googleCredential = response.credential;
    const r = await guard(() => api.auth.google(response.credential), {
        onError: (err) => {
            if (err.code === 'PASSWORD_REQUIRED') {
                $('googleLinkEmail').textContent = googleEmailOf(response.credential);
                $('googleLinkPassword').value = '';
                modal('googleLinkModal').show();
                return true; // handled: no error toast
            }
            return false;
        }
    });
    if (r) afterLogin(r);
}

// Only used to tell the person WHICH email is being connected; the server never trusts this value
function googleEmailOf(credential) {
    try {
        const payload = JSON.parse(atob(credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return payload.email || 'this email';
    } catch (e) { return 'this email'; }
}

const googleLinkHandler = async () => {
    const r = await guard(() => api.auth.google(state.googleCredential, $('googleLinkPassword').value));
    if (!r) return;
    hideModal('googleLinkModal');
    state.googleCredential = null;
    afterLogin(r);
};

/* ---------------------------- 4. sign-up / login --------------------------- */
function updateSignupCountryUI() {
    const c = getCountry($('signupCountry').value);
    $('signupRegionLabel').textContent = c.regionLabel + (c.regionRequired ? '' : ' (optional)');
    $('signupRegion').required = c.regionRequired;
    $('signupPriceLabel').textContent = `Hourly Rate (${c.currency})`;
    $('signupPrice').min = c.minHourlyRate;
    $('signupPriceHint').textContent = `Minimum in ${c.name}: ${money(c.minHourlyRate, c)} per hour.`;
}

// After any login: send people where they belong
function afterLogin(r, message) {
    setSession(r.token, r.user);
    state.chef = r.chef || null;
    renderNav();
    notify(message || (r.isNew ? `Welcome to MyMealChef, ${r.user.firstName}! Your account is ready.` : `Welcome back, ${r.user.firstName}!`));
    if (r.user.role === 'admin') showPage('adminPage');
    else if (r.user.role === 'chef') showPage('extranetPage');
    else { const back = state.returnTo || 'homePage'; state.returnTo = null; showPage(back); }
}

const formHandlers = {
    async customerLoginForm() {
        const r = await guard(() => api.auth.login({ email: $('custLoginEmail').value.trim(), password: $('custLoginPassword').value }));
        if (r) afterLogin(r);
    },

    async chefLoginForm() {
        const r = await guard(() => api.auth.login({ email: $('loginEmail').value.trim(), password: $('loginPassword').value }));
        if (r) afterLogin(r);
    },

    async customerRegisterForm() {
        const r = await guard(() => api.auth.register({
            firstName: $('custFirstName').value.trim(), lastName: $('custLastName').value.trim(),
            email: $('custEmail').value.trim(), password: $('custPassword').value
        }));
        if (!r) return;
        setSession(r.token, r.user);
        renderNav();
        notify('Account created! We sent a confirmation link to your email: confirm it to start booking.');
        showPage('cuisinesPage');
    },

    async chefSignupForm() {
        const c = getCountry($('signupCountry').value);
        const rate = Number($('signupPrice').value);
        if (rate < c.minHourlyRate) {
            notify(`The minimum hourly rate in ${c.name} is ${money(c.minHourlyRate, c)}.`, 'warning');
            return;
        }
        const r = await guard(() => api.auth.registerChef({
            firstName: $('signupFirstName').value.trim(), lastName: $('signupLastName').value.trim(),
            email: $('signupEmail').value.trim(), password: $('signupPassword').value,
            bio: $('signupBio').value.trim(), experience: Number($('signupExperience').value),
            cuisineSpecialization: $('signupCuisine').value,
            additionalCuisines: $('signupAdditionalCuisines').value.split(',').map((item) => item.trim()).filter(Boolean),
            signatureDishes: $('signupSignatureDishes').value.split(',').map((item) => item.trim()).filter(Boolean), hourlyRate: rate,
            serviceLocation: { country: c.code, city: $('signupCity').value.trim(), state: $('signupRegion').value.trim() }
        }));
        if (!r) return;
        setSession(r.token, r.user);
        state.chef = r.chef;
        renderNav();
        $('chefSignupForm').reset();
        notify('Account created! We sent a confirmation link to your email. Confirm it, then complete your application.');
        showPage('extranetPage');
    },

    async contactForm() {
        const r = await guard(() => api.contact.submit({
            name: $('contactName').value.trim(), email: $('contactEmail').value.trim(),
            subject: $('contactSubject').value, message: $('contactMessage').value.trim()
        }));
        if (r) { notify('Thank you! We will get back to you within 24-48 hours.'); $('contactForm').reset(); }
    }
};

/* ------------------------ 5. booking: calendar + time slots ---------------------- */
function startBooking(chefId) {
    if (!state.user) {
        notify('Please log in or create an account to book a chef.', 'info');
        state.returnTo = 'cuisinesPage';
        showPage('customerAuthPage');
        return;
    }
    if (state.user.role !== 'customer') {
        notify('Only customer accounts can book a chef.', 'warning');
        return;
    }
    ensureVerified().then((ok) => { if (ok) openBooking(chefId); });
}

async function openBooking(chefId) {
    let chef = state.chefs.find((c) => c._id === chefId) || (state.currentProfileChef?._id === chefId ? state.currentProfileChef : null);
    if (!chef) {
        const fetched = await guard(() => api.chefs.getById(chefId));
        if (!fetched) return;
        chef = fetched.data;
        state.chefs.push(chef);
    }
    const c = getCountry(chef.serviceLocation && chef.serviceLocation.country);
    const today = todayIn(c.timezone);
    const [ty, tm] = today.split('-').map(Number);

    state.booking = {
        chef, country: c, today, year: ty, month: tm - 1, minYM: ty * 12 + (tm - 1),
        avail: {}, date: null, slot: null, duration: 3, slots: []
    };

    $('modalChefName').textContent = `${chef.user.firstName} ${chef.user.lastName}`;
    $('modalChefRate').textContent = `${money(chef.hourlyRate, c)} / hour`;
    $('bookingForm').reset();
    $('bookingDuration').value = '3';
    $('addrRegionLabel').textContent = c.regionLabel + (c.regionRequired ? '' : ' (optional)');
    $('addrPostalLabel').textContent = c.postalLabel + (c.postalRequired ? '' : ' (optional)');
    $('addrCountry').value = c.name;
    $('slotPicker').innerHTML = '';
    $('slotMessage').textContent = 'Pick a date to see the available times.';
    $('chefTimeOffInfo').innerHTML = '';
    updateBookingSummary();
    modal('bookingModal').show();
    await renderBookingCalendar();
}

async function loadMonth(year, month) {
    const b = state.booking;
    const key = `${year}-${pad(month + 1)}`;
    if (b.avail[key]) return b.avail[key];
    const first = ymd(year, month, 1);
    const last = ymd(year, month, new Date(year, month + 1, 0).getDate());
    if (last < b.today) return (b.avail[key] = { unavailable: new Set(), booked: {}, blocked: {}, timeOff: [] });
    const from = first < b.today ? b.today : first;
    const r = await api.chefs.getAvailability(b.chef._id, from, last);
    return (b.avail[key] = {
        unavailable: new Set(r.data), booked: r.meta.bookedSlots || {}, blocked: r.meta.blockedSlots || {}, timeOff: r.meta.timeOff || []
    });
}

async function renderBookingCalendar() {
    const b = state.booking;
    const box = $('bookingCalendar');
    box.innerHTML = '<div class="text-center text-muted py-4">Loading calendar…</div>';
    let data;
    try { data = await loadMonth(b.year, b.month); }
    catch (e) { box.innerHTML = `<div class="text-danger small">${esc(e.message)}</div>`; return; }
    if (state.booking !== b) return; // the modal was reopened for another chef

    const ym = b.year * 12 + b.month;
    const monthName = new Date(Date.UTC(b.year, b.month, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const lead = new Date(b.year, b.month, 1).getDay(); // 0 = Sunday
    const days = new Date(b.year, b.month + 1, 0).getDate();

    let cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<div class="cal-weekday">${d}</div>`).join('');
    for (let i = 0; i < lead; i++) cells += '<div class="calendar-day blank"></div>';
    for (let d = 1; d <= days; d++) {
        const date = ymd(b.year, b.month, d);
        let cls = 'free', disabled = false;
        if (date < b.today) { cls = 'past'; disabled = true; }
        else if (data.unavailable.has(date)) { cls = 'booked'; disabled = true; }
        else if (data.booked[date] || data.blocked[date]) cls = 'partial';
        if (date === b.date) cls += ' selected';
        cells += `<button type="button" class="calendar-day ${cls}" ${disabled ? 'disabled' : ''} data-action="pickDate" data-date="${date}">${d}</button>`;
    }

    box.innerHTML = `<div class="cal-head">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-action="calPrev" ${ym <= b.minYM ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>
            <span class="cal-title">${esc(monthName)}</span>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-action="calNext" ${ym >= b.minYM + MAX_MONTHS_AHEAD ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>
        </div><div class="cal-grid">${cells}</div>`;

    renderChefTimeOffInfo();
}

// The chef's planned time off (private notes are never sent by the server)
function renderChefTimeOffInfo() {
    const b = state.booking;
    const seen = new Map();
    Object.values(b.avail).forEach((m) => m.timeOff.forEach((t) => { if (t.endDate >= b.today) seen.set(t.id, t); }));
    const items = [...seen.values()].sort((x, y) => x.startDate.localeCompare(y.startDate));
    if (!items.length) { $('chefTimeOffInfo').innerHTML = ''; return; }
    const line = (t) => {
        const when = t.startDate === t.endDate ? fmtDay(t.startDate) : `${fmtDay(t.startDate)} – ${fmtDay(t.endDate)}`;
        return `<li>${esc(when)} ${t.allDay ? '(all day)' : `(${esc(time12(t.startTime))} – ${esc(time12(t.endTime))} each day)`}</li>`;
    };
    $('chefTimeOffInfo').innerHTML = `<div class="small"><strong><i class="fas fa-calendar-xmark me-1"></i>Chef is away:</strong><ul class="mb-0 mt-1">${items.map(line).join('')}</ul></div>`;
}

async function changeMonth(delta) {
    const b = state.booking;
    const total = b.year * 12 + b.month + delta;
    if (total < b.minYM || total > b.minYM + MAX_MONTHS_AHEAD) return;
    b.year = Math.floor(total / 12);
    b.month = total % 12;
    await renderBookingCalendar();
}

async function pickDate(date) {
    const b = state.booking;
    b.date = date;
    b.slot = null;
    $('bookingDate').value = fmtDate(date);
    await renderBookingCalendar();
    await loadSlots();
}

async function loadSlots() {
    const b = state.booking;
    if (!b || !b.date) return;
    b.slot = null;
    b.duration = Number($('bookingDuration').value) || 3;
    $('slotPicker').innerHTML = '<span class="text-muted small">Loading times…</span>';
    try {
        const r = await api.chefs.getSlots(b.chef._id, b.date, b.duration);
        if (state.booking !== b) return;
        b.slots = r.slots;
        if (!r.slots.length) {
            $('slotPicker').innerHTML = '';
            $('slotMessage').textContent = r.reason || 'No free time on this day. Please pick another date.';
        } else {
            $('slotMessage').textContent = `The chef works ${time12(r.workingHours.start)} – ${time12(r.workingHours.end)}. Choose when the chef should arrive:`;
            $('slotPicker').innerHTML = r.slots.map((t) => `<button type="button" class="slot-btn" data-action="pickSlot" data-time="${t}">${time12(t)}</button>`).join('');
        }
    } catch (e) {
        $('slotPicker').innerHTML = '';
        $('slotMessage').textContent = e.message;
    }
    updateBookingSummary();
}

function pickSlot(time) {
    state.booking.slot = time;
    document.querySelectorAll('#slotPicker .slot-btn').forEach((btn) => btn.classList.toggle('selected', btn.dataset.time === time));
    updateBookingSummary();
}

function updateBookingSummary() {
    const b = state.booking;
    const box = $('bookingSummary');
    if (!b) { box.textContent = ''; return; }
    const hours = Number($('bookingDuration').value) || 3;
    const total = money(b.chef.hourlyRate * hours, b.country);
    if (!b.slot) { box.innerHTML = `<strong>Estimated total: ${esc(total)}</strong> for ${hours} hours`; return; }
    box.innerHTML = `<div><i class="far fa-calendar me-1"></i>${esc(fmtDate(b.date))}</div>
        <div><i class="far fa-clock me-1"></i>Chef arrives ${esc(time12(b.slot))} and stays until ${esc(time12(endOf(b.slot, hours)))}</div>
        <div class="mt-1"><strong>Total: ${esc(total)}</strong> (${hours} hours)</div>`;
}

async function confirmBooking() {
    const b = state.booking;
    if (!b) return;
    const c = b.country;
    const v = (id) => $(id).value.trim();
    const problems = [];
    if (!b.date) problems.push('Pick a date.');
    else if (!b.slot) problems.push('Choose a time.');
    if (!v('addrStreet')) problems.push('Enter the street or building.');
    if (!v('addrCity')) problems.push('Enter the city or town.');
    if (c.regionRequired && !v('addrRegion')) problems.push(`Enter the ${c.regionLabel.toLowerCase()}.`);
    if (c.postalRequired && !v('addrPostal')) problems.push(`Enter the ${c.postalLabel.toLowerCase()}.`);
    const guests = Number($('bookingGuests').value);
    if (!(guests >= 1 && guests <= 50)) problems.push('Guests must be between 1 and 50.');
    if (problems.length) { notify(problems[0], 'warning'); return; }

    const occasion = v('bookingOccasion');
    const menuPreference = v('bookingMenuType');
    const menuType = menuPreference === 'Custom menu' ? 'custom' : menuPreference === 'I have dishes in mind' ? 'pre-set' : 'chef-choice';
    const notes = v('bookingNotes');
    const specialRequests = [`Occasion: ${occasion}`, `Menu preference: ${menuPreference}`, notes ? `Guest notes: ${notes}` : ''].filter(Boolean).join('\n');
    const r = await guard(() => api.bookings.create({
        chefId: b.chef._id, date: b.date, startTime: b.slot, duration: b.duration, numberOfGuests: guests,
        address: { street: v('addrStreet'), city: v('addrCity'), state: v('addrRegion'), zipCode: v('addrPostal'), country: c.code },
        menuType, specialRequests
    }), {
        // someone else took the slot a moment ago: refresh what the customer sees
        onError: async (err) => { if (err.status === 409) { b.avail = {}; await renderBookingCalendar(); await loadSlots(); } }
    });
    if (!r) return;
    hideModal('bookingModal');
    state.booking = null;
    notify('Booking request sent! The chef will confirm or reply shortly.');
    showPage('myBookingsPage');
}

/* ---------------------------- 6. customer dashboard --------------------------- */
const addressText = (a) => [a.street, a.city, a.state, a.zipCode].filter(Boolean).join(', ');
const bookingEnd = (b) => (b.endMinutes ? minToHHMM(b.endMinutes) : endOf(b.startTime, b.duration));

async function loadMyBookings() {
    const sid = sessionId;
    const box = $('myBookingsList');
    box.innerHTML = '<div class="text-center text-muted py-5">Loading your bookings…</div>';
    const r = await guard(() => api.bookings.getMy());
    if (sid !== sessionId) return;
    if (!r) { box.innerHTML = ''; return; }
    state.myBookings = r.data;
    renderMyBookings();
    loadMyOrders();
}

function renderMyBookings() {
    const box = $('myBookingsList');
    if (!state.myBookings.length) {
        box.innerHTML = '<div class="alert alert-light border">You have no bookings yet. Browse the cuisines and book your first chef!</div>';
        return;
    }
    box.innerHTML = state.myBookings.map((b) => {
        const c = getCountry(b.country);
        const chefUser = (b.chef && b.chef.user) || {};
        const chefName = `${chefUser.firstName || 'Your'} ${chefUser.lastName || 'chef'}`;
        let extra = '';
        if ((b.status === 'rejected' || b.status === 'cancelled') && b.statusReason) {
            const who = b.status === 'rejected' ? 'Declined' : 'Cancelled';
            extra = `<div class="reason-box"><strong>${who} by the chef:</strong> ${esc(reasonLabel(b.statusReason.code))}${b.statusReason.note ? `<br><em>"${esc(b.statusReason.note)}"</em>` : ''}</div>`;
        }
        let action = '';
        if (b.status === 'completed') {
            action = b.rating && b.rating.score
                ? `<div class="mt-2">${stars(b.rating.score)} <small class="text-muted">Thanks for your review</small></div>`
                : `<button class="btn btn-sm btn-outline-primary mt-2" data-action="openReview" data-id="${esc(b._id)}"><i class="far fa-star me-1"></i>Leave a review</button>`;
        }
        return `<div class="booking-card">
            <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
                <div>
                    <h5 class="mb-1">Chef ${esc(chefName)} ${b.chef && b.chef.cuisineSpecialization ? `<small class="text-muted">· ${esc(b.chef.cuisineSpecialization)}</small>` : ''}</h5>
                    <div><i class="far fa-calendar me-1"></i>${esc(fmtDate(dateKey(b.date)))} &nbsp; <i class="far fa-clock me-1"></i>${esc(time12(b.startTime))} – ${esc(time12(bookingEnd(b)))}</div>
                    <div class="text-muted small"><i class="fas fa-map-marker-alt me-1"></i>${esc(addressText(b.address))} &middot; ${esc(b.numberOfGuests)} guests</div>
                    ${b.specialRequests ? `<div class="text-muted small">Requests: ${esc(b.specialRequests)}</div>` : ''}
                </div>
                <div class="text-end">${statusBadge(b.status)}<div class="mt-1"><strong>${esc(money(b.totalPrice, c))}</strong></div></div>
            </div>
            ${extra}${action}
        </div>`;
    }).join('');
}

function openReview(id) {
    $('reviewBookingId').value = id;
    $('reviewScore').value = '5';
    $('reviewText').value = '';
    modal('reviewModal').show();
}

formHandlers.googleLinkForm = googleLinkHandler;

/* ---- forgot / reset password ---- */
function openForgot() {
    // reuse whatever email the person already typed on a login form
    const typed = $('custLoginEmail').value.trim() || $('loginEmail').value.trim();
    $('forgotEmail').value = typed;
    modal('forgotModal').show();
}

formHandlers.forgotForm = async () => {
    const r = await guard(() => api.auth.forgotPassword($('forgotEmail').value.trim()));
    if (!r) return;
    hideModal('forgotModal');
    notify(r.message, 'info'); // same wording whether or not the email has an account
};

formHandlers.resetForm = async () => {
    const pw = $('resetPassword').value;
    if (pw.length < 6) { notify('The password must be at least 6 characters.', 'warning'); return; }
    if (pw !== $('resetPassword2').value) { notify('The two passwords do not match.', 'warning'); return; }
    const r = await guard(() => api.auth.resetPassword(state.resetToken, pw), {
        onError: (err) => { if (err.status === 400 && /invalid or has expired/i.test(err.message)) $('resetExpired').style.display = 'block'; return false; }
    });
    if (!r) return;
    state.resetToken = null;
    $('resetForm').reset();
    afterLogin(r, 'Your password was updated and you are signed in.');
};

// The emailed link looks like  https://site/#reset=<token>. The token is read, then removed from the address bar.
function takeHashToken(name) {
    const m = location.hash.match(new RegExp(`^#${name}=([a-f0-9]{64})$`, 'i'));
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search); // remove the token from the address bar and history
    return m[1].toLowerCase();
}

// The emailed confirmation link looks like  https://site/#verify=<token>
async function confirmEmail(token) {
    showPage('verifyEmailPage');
    const box = $('verifyResult');
    box.innerHTML = '<p class="text-muted">Confirming your email address…</p>';
    try {
        const r = await api.auth.verifyEmail(token);
        if (state.user && state.user.email === r.email) { state.user.emailVerified = true; renderNav(); } // same browser: hide the reminder
        const next = !state.user ? ['customerAuthPage', 'Log in'] : state.user.role === 'chef' ? ['extranetPage', 'Continue to my dashboard'] : state.user.role === 'admin' ? ['adminPage', 'Continue'] : ['cuisinesPage', 'Find a chef'];
        box.innerHTML = `<div class="display-4 text-success mb-3"><i class="fas fa-circle-check"></i></div>
            <h2>Email confirmed</h2><p class="text-muted">${esc(r.email)} is confirmed. Thank you!</p>
            <a class="btn btn-primary" href="#" data-action="goPage" data-page="${next[0]}">${next[1]}</a>`;
    } catch (err) {
        box.innerHTML = `<div class="display-4 text-warning mb-3"><i class="fas fa-triangle-exclamation"></i></div>
            <h2>This link did not work</h2><p class="text-muted">${esc(err.message)}</p>
            <a class="btn btn-primary" href="#" data-action="goPage" data-page="customerAuthPage">Log in</a>`;
    }
}

// Coming back to this tab after clicking the link in the email: pick up the new status
window.addEventListener('focus', () => { if (state.user && state.user.emailVerified === false) refreshMe(); });

// Pressing Enter inside the booking form must not reload the page
formHandlers.bookingForm = () => confirmBooking();

formHandlers.reviewForm = async () => {
    const r = await guard(() => api.bookings.addReview($('reviewBookingId').value, { score: Number($('reviewScore').value), review: $('reviewText').value.trim() }));
    if (!r) return;
    hideModal('reviewModal');
    notify('Thank you for your review!');
    loadMyBookings();
};

/* ----------------------------- 7. chef dashboard ----------------------------- */
function renderExtranet() {
    const u = state.user;
    $('chefAuthBox').style.display = $('chefDashboard').style.display = $('extranetNotice').style.display = 'none';
    if (!u) { $('chefAuthBox').style.display = 'block'; updateSignupCountryUI(); return; }
    if (u.role !== 'chef') {
        const n = $('extranetNotice');
        n.style.display = 'block';
        n.innerHTML = `You are logged in as ${esc(u.role)}. <a href="#" data-action="logout">Log out</a> to sign in or register as a chef.`;
        return;
    }
    $('chefDashboard').style.display = 'block';
    loadChefDashboard(true);
}

async function loadChefDashboard(pickTab = false) {
    const sid = sessionId;
    $('chefName').textContent = state.user.firstName;
    if (!$('applicationPanel').innerHTML) $('applicationPanel').innerHTML = '<div class="text-muted py-4">Loading your dashboard…</div>';
    await loadMeta();
    const results = await guard(() => Promise.all([
        api.chefs.getMyProfile(), api.auth.myApplication(), api.bookings.getMy(), api.chefs.getTimeOff(),
        api.orders.list(), api.kitchens.mine(), api.meals.list()
    ]));
    if (!results || sid !== sessionId || !state.user) return;
    state.chef = results[0].data;
    state.application = results[1].data;
    state.chefBookings = results[2].data;
    state.timeOff = results[3].data;
    state.chefOrders = results[4].data;
    state.kitchenSettings = results[5].data;
    state.meals = results[6].data;
    if (!state.chefCal.year) {
        const [y, m] = todayIn(getCountry(state.chef.serviceLocation.country).timezone).split('-').map(Number);
        state.chefCal = { year: y, month: m - 1 };
    }
    renderChefStatus();
    renderApplicationPanel();
    renderChefBookings();
    renderChefOrders();
    renderKitchenPanel();
    renderAvailability();
    renderProfile();
    loadChefStories();
    if (pickTab) bootstrap.Tab.getOrCreateInstance($(state.chef.isVerified ? 'tabBookingsBtn' : 'tabApplicationBtn')).show();
}

const chefStage = () => (state.chef.isVerified ? 'approved' : state.application.applicationStatus);

function renderChefStatus() {
    const stages = {
        'not-submitted': ['bg-warning text-dark', 'Application needed'], submitted: ['bg-info text-dark', 'Application under review'],
        'interview-scheduled': ['bg-primary', 'Interview scheduled'], interviewed: ['bg-info text-dark', 'Awaiting final approval'],
        approved: ['bg-success', 'Live: customers can book you'], rejected: ['bg-danger', 'Not approved']
    };
    const [cls, label] = stages[chefStage()] || ['bg-secondary', chefStage()];
    const el = $('chefStatusBadge');
    el.className = `badge ${cls}`;
    el.textContent = label;
}

/* ---- application tab ---- */
function applicationFormHtml() {
    const dial = getCountry(state.chef.serviceLocation.country).dialCode;
    const dialOptions = state.countries.map((c) => `<option value="${esc(c.dialCode)}" ${c.dialCode === dial ? 'selected' : ''}>${esc(c.dialCode)} (${esc(c.name)})</option>`).join('');
    const questions = INTERVIEW_QUESTIONS.map((q, i) => `<div class="mb-3">
        <label class="form-label" for="appAnswer${i}">${esc(q)}</label>
        <textarea class="form-control" id="appAnswer${i}" rows="3" maxlength="2000" required></textarea></div>`).join('');
    return `<form id="chefApplicationForm" class="card"><div class="card-body">
        <h5 class="card-title">Complete your application</h5>
        ${state.user && state.user.emailVerified === false ? '<div class="alert alert-warning">Confirm your email address first: we sent you a link. <a href="#" data-action="resendVerification">Resend the email</a></div>' : ''}
        <p class="text-muted">To keep customers safe, every chef is checked. Send your documents, then our team holds a <strong>short live interview (call or video)</strong>. You can only go live after you pass it.</p>
        <h6 class="mt-4">1. Phone number for your interview</h6>
        <div class="row g-2 mb-1">
            <div class="col-5 col-md-4"><select class="form-select" id="appDial" aria-label="Country code">${dialOptions}</select></div>
            <div class="col-7 col-md-8"><input type="tel" class="form-control" id="appPhone" placeholder="712 345 678" inputmode="tel" required></div>
        </div>
        <div class="form-text mb-3">We will call you on this number. WhatsApp calls are fine.</div>
        <div class="mb-3"><label class="form-label" for="appPreferred">When are you usually free for the interview? (optional)</label>
            <input type="text" class="form-control" id="appPreferred" maxlength="300" placeholder="e.g. Weekdays after 5 pm, Saturday mornings"></div>
        <h6 class="mt-4">2. A few questions</h6>${questions}
        <h6 class="mt-4">3. Documents</h6>
        <div class="mb-3"><label class="form-label" for="appPassport">Passport or national ID photo <span class="text-danger">*</span></label>
            <input type="file" class="form-control" id="appPassport" accept="image/png,image/jpeg,application/pdf" required>
            <div class="form-text">JPG, PNG or PDF, up to 5 MB. Only our admins can see it.</div></div>
        <div class="mb-3"><label class="form-label" for="appCertificate">Culinary or food-hygiene certificate (optional)</label>
            <input type="file" class="form-control" id="appCertificate" accept="image/png,image/jpeg,application/pdf"></div>
        <button type="submit" class="btn btn-primary">Submit application</button>
    </div></form>`;
}

function renderApplicationPanel() {
    const box = $('applicationPanel');
    const chef = state.chef, app = state.application;
    const tz = getCountry(chef.serviceLocation.country).timezone;
    const stage = chefStage();
    const steps = (active) => {
        const names = ['Apply', 'Live interview', 'Approved'];
        return `<ol class="step-list text-muted small mb-3">${names.map((n, i) => `<li ${i === active ? 'class="fw-bold text-dark"' : ''}>${n}</li>`).join('')}</ol>`;
    };

    if (stage === 'approved') {
        box.innerHTML = '<div class="alert alert-success"><i class="fas fa-circle-check me-2"></i><strong>You are approved and live!</strong> Customers can now find and book you. Set your working hours and time off in the Availability tab.</div>';
    } else if (stage === 'not-submitted') {
        box.innerHTML = steps(0) + applicationFormHtml();
    } else if (stage === 'rejected') {
        box.innerHTML = `<div class="alert alert-danger"><strong>Your application was not approved.</strong>${app.reviewNote ? `<br>${esc(app.reviewNote)}` : ''}<br>You can update your details below and apply again.</div>${applicationFormHtml()}`;
    } else if (stage === 'submitted') {
        box.innerHTML = steps(1) + `<div class="alert alert-info"><i class="fas fa-hourglass-half me-2"></i><strong>Application received.</strong> Our team will review it and contact you on <strong>${esc(app.phone)}</strong> to arrange your live interview.</div>
            <button class="btn btn-sm btn-outline-secondary" data-action="reapply">Change my phone number or documents</button><div id="reapplyBox" class="mt-3"></div>`;
    } else if (stage === 'interview-scheduled') {
        const iv = app.interview || {};
        box.innerHTML = steps(1) + `<div class="alert alert-primary"><i class="fas fa-video me-2"></i><strong>Your live interview is booked</strong>
            <div class="fs-5 my-1">${esc(fmtDateTime(iv.scheduledAt, tz))}</div>
            ${iv.meetingLink ? `<a class="btn btn-primary btn-sm" href="${esc(iv.meetingLink)}" target="_blank" rel="noopener">Join the video call</a>` : `We will call you on <strong>${esc(app.phone)}</strong>.`}
            <div class="small mt-2">Please keep your passport and certificates at hand.</div></div>`;
    } else if (stage === 'interviewed') {
        box.innerHTML = steps(2) + '<div class="alert alert-info"><i class="fas fa-thumbs-up me-2"></i><strong>You passed the interview!</strong> We are finishing the final approval. You will get an email as soon as your profile is live.</div>';
    }
}

formHandlers.chefApplicationForm = async () => {
    if (!(await ensureVerified())) return;
    const phone = buildPhone($('appDial').value, $('appPhone').value);
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) { notify('Enter a valid phone number.', 'warning'); return; }
    const passport = $('appPassport').files[0];
    const cert = $('appCertificate').files[0];
    if (!passport) { notify('Please attach your passport or ID photo.', 'warning'); return; }
    if ([passport, cert].some((f) => f && f.size > 5 * 1024 * 1024)) { notify('Each file must be 5 MB or smaller.', 'warning'); return; }

    const fd = new FormData();
    fd.append('phone', phone);
    fd.append('preferredInterviewTimes', $('appPreferred').value.trim());
    fd.append('answers', JSON.stringify(INTERVIEW_QUESTIONS.map((q, i) => ({ question: q, answer: $(`appAnswer${i}`).value.trim() }))));
    fd.append('passportPhoto', passport);
    if (cert) fd.append('certificate', cert);

    const r = await guard(() => api.auth.submitApplication(fd));
    if (!r) return;
    notify('Application submitted! We will contact you to arrange your live interview.');
    loadChefDashboard();
};

/* ---- bookings tab ---- */
function renderChefBookings() {
    const box = $('bookingsList');
    const list = [...state.chefBookings].sort((a, b) => {
        const rank = (x) => (x.status === 'pending' ? 0 : x.status === 'confirmed' ? 1 : 2);
        return rank(a) - rank(b) || dateKey(a.date).localeCompare(dateKey(b.date));
    });
    const pending = list.filter((b) => b.status === 'pending').length;
    const badge = $('pendingCount');
    badge.style.display = pending ? 'inline-block' : 'none';
    badge.textContent = pending;

    const note = state.chef.isVerified ? '' : '<div class="alert alert-warning">Your profile is not live yet, so customers cannot book you. Finish your application first.</div>';
    if (!list.length) { box.innerHTML = `${note}<div class="alert alert-light border">No bookings yet.</div>`; return; }

    const tz = getCountry(state.chef.serviceLocation.country).timezone;
    const today = todayIn(tz);
    box.innerHTML = note + list.map((b) => {
        const c = getCountry(b.country);
        const cu = b.customer || {};
        let actions = '';
        if (b.status === 'pending') {
            actions = `<button class="btn btn-success btn-sm me-2" data-action="chefStatus" data-id="${esc(b._id)}" data-status="confirmed"><i class="fas fa-check me-1"></i>Accept</button>
                <button class="btn btn-outline-danger btn-sm" data-action="chefReject" data-id="${esc(b._id)}" data-mode="rejected"><i class="fas fa-xmark me-1"></i>Decline</button>`;
        } else if (b.status === 'confirmed') {
            if (dateKey(b.date) <= today) actions += `<button class="btn btn-primary btn-sm me-2" data-action="chefStatus" data-id="${esc(b._id)}" data-status="completed">Mark as completed</button>`;
            actions += `<button class="btn btn-outline-danger btn-sm" data-action="chefReject" data-id="${esc(b._id)}" data-mode="cancelled">Cancel booking</button>`;
        }
        const reason = b.statusReason && (b.status === 'rejected' || b.status === 'cancelled')
            ? `<div class="reason-box"><strong>Your reason:</strong> ${esc(reasonLabel(b.statusReason.code))}${b.statusReason.note ? ` – "${esc(b.statusReason.note)}"` : ''}</div>` : '';
        return `<div class="booking-card">
            <div class="d-flex justify-content-between flex-wrap gap-2">
                <div>
                    <h6 class="mb-1">${esc(cu.firstName)} ${esc(cu.lastName)} <small class="text-muted">${esc(cu.email)}</small></h6>
                    <div><i class="far fa-calendar me-1"></i>${esc(fmtDate(dateKey(b.date)))} &nbsp; <i class="far fa-clock me-1"></i>${esc(time12(b.startTime))} – ${esc(time12(bookingEnd(b)))}</div>
                    <div class="small text-muted"><i class="fas fa-map-marker-alt me-1"></i>${esc(addressText(b.address))} &middot; ${esc(b.numberOfGuests)} guests</div>
                    ${b.specialRequests ? `<div class="small">Requests: ${esc(b.specialRequests)}</div>` : ''}
                </div>
                <div class="text-end">${statusBadge(b.status)}<div class="mt-1"><strong>${esc(money(b.totalPrice, c))}</strong></div></div>
            </div>${reason}<div class="mt-2">${actions}</div>
        </div>`;
    }).join('');
}

async function chefSetStatus(id, status) {
    const r = await guard(() => api.bookings.updateStatus(id, status));
    if (!r) return;
    notify(status === 'confirmed' ? 'Booking accepted. The customer has been notified.' : 'Booking marked as completed.');
    loadChefDashboard();
}

function openReject(id, mode) {
    $('rejectBookingId').value = id;
    $('rejectStatus').value = mode;
    $('rejectTitle').textContent = mode === 'rejected' ? 'Decline this booking request' : 'Cancel this booking';
    $('rejectSubmit').textContent = mode === 'rejected' ? 'Decline booking' : 'Cancel booking';
    const reasons = state.reasonCodes.length ? state.reasonCodes : [{ code: 'other', label: 'Other' }];
    $('rejectReason').innerHTML = reasons.map((r) => `<option value="${esc(r.code)}">${esc(r.label)}</option>`).join('');
    $('rejectNote').value = '';
    modal('rejectModal').show();
}

formHandlers.rejectForm = async () => {
    const status = $('rejectStatus').value;
    const r = await guard(() => api.bookings.updateStatus($('rejectBookingId').value, status, {
        reasonCode: $('rejectReason').value, reason: $('rejectNote').value.trim()
    }));
    if (!r) return;
    hideModal('rejectModal');
    notify(status === 'rejected' ? 'Booking declined. The customer was told why.' : 'Booking cancelled. The customer was told why.');
    loadChefDashboard();
};

/* ---- availability tab ---- */
function renderAvailability() {
    const chef = state.chef;
    const avail = chef.availability || {};
    $('weekdayChecks').innerHTML = WEEKDAYS.map((d) => `<div class="form-check">
        <input class="form-check-input" type="checkbox" id="wd_${d}" ${avail[d] === false ? '' : 'checked'}>
        <label class="form-check-label text-capitalize" for="wd_${d}">${d.slice(0, 3)}</label></div>`).join('');
    $('hoursStart').value = (chef.workingHours && chef.workingHours.start) || '08:00';
    $('hoursEnd').value = (chef.workingHours && chef.workingHours.end) || '22:00';
    const tz = getCountry(chef.serviceLocation.country).timezone;
    $('toStart').min = $('toEnd').min = todayIn(tz);
    renderTimeOffList();
    renderChefCalendar();
}

formHandlers.workingHoursForm = async () => {
    const availability = Object.fromEntries(WEEKDAYS.map((d) => [d, $(`wd_${d}`).checked]));
    if (!Object.values(availability).some(Boolean)) { notify('Keep at least one working day.', 'warning'); return; }
    const r = await guard(() => api.chefs.update(state.chef._id, { availability, workingHours: { start: $('hoursStart').value, end: $('hoursEnd').value } }));
    if (!r) return;
    notify('Working hours saved.');
    loadChefDashboard();
};

function renderTimeOffList() {
    const box = $('timeOffList');
    if (!state.timeOff.length) { box.innerHTML = '<div class="text-muted small">You have not blocked any time off.</div>'; return; }
    box.innerHTML = state.timeOff.map((t) => {
        const when = t.startDate === t.endDate ? fmtDay(t.startDate) : `${fmtDay(t.startDate)} – ${fmtDay(t.endDate)}`;
        const part = t.allDay ? 'All day' : `${time12(t.startTime)} – ${time12(t.endTime)} each day`;
        return `<div class="d-flex justify-content-between align-items-center border-bottom py-2">
            <div><strong>${esc(when)}</strong> <span class="text-muted">· ${esc(part)}</span>${t.note ? `<div class="small text-muted">${esc(t.note)}</div>` : ''}</div>
            <button class="btn btn-sm btn-outline-danger" data-action="deleteTimeOff" data-id="${esc(t._id)}" title="Remove"><i class="fas fa-trash"></i></button></div>`;
    }).join('');
}

formHandlers.timeOffForm = async () => {
    const allDay = $('toAllDay').checked;
    const payload = { startDate: $('toStart').value, endDate: $('toEnd').value, allDay, note: $('toNote').value.trim() };
    if (!payload.startDate || !payload.endDate) { notify('Choose the dates.', 'warning'); return; }
    if (payload.endDate < payload.startDate) { notify('The end date cannot be before the start date.', 'warning'); return; }
    if (!allDay) {
        payload.startTime = $('toStartTime').value;
        payload.endTime = $('toEndTime').value;
        if (!payload.startTime || !payload.endTime || payload.endTime <= payload.startTime) { notify('Choose a start time and a later end time.', 'warning'); return; }
    }
    const r = await guard(() => api.chefs.addTimeOff(payload));
    if (!r) return;
    $('timeOffForm').reset();
    $('toTimes').style.display = 'none';
    notify('Time off saved. Customers can no longer book you then.');
    const w = $('timeOffWarnings');
    w.innerHTML = r.warnings && r.warnings.length
        ? `<div class="alert alert-warning mb-0"><strong>You already have bookings in this period.</strong> They were not cancelled. Decline or cancel them in the Bookings tab if you cannot attend:<ul class="mb-0">${r.warnings.map((x) => `<li>${esc(fmtDay(x.date))} at ${esc(time12(x.startTime))} (${esc(x.status)})</li>`).join('')}</ul></div>`
        : '';
    const to = await guard(() => api.chefs.getTimeOff(), { quiet: true });
    if (to) state.timeOff = to.data;
    renderTimeOffList();
    renderChefCalendar();
};

async function removeTimeOff(id) {
    if (!confirm('Remove this time-off period? Customers will be able to book you then again.')) return;
    const r = await guard(() => api.chefs.deleteTimeOff(id));
    if (!r) return;
    state.timeOff = state.timeOff.filter((t) => t._id !== id);
    $('timeOffWarnings').innerHTML = '';
    renderTimeOffList();
    renderChefCalendar();
    notify('Time off removed.');
}

// The chef's own month view: bookings, days off, and part-day time off
function renderChefCalendar() {
    const { year, month } = state.chefCal;
    const chef = state.chef;
    const tz = getCountry(chef.serviceLocation.country).timezone;
    const today = todayIn(tz);
    const avail = chef.availability || {};
    const active = state.chefBookings.filter((b) => ['pending', 'confirmed', 'in-progress'].includes(b.status));
    const monthName = new Date(Date.UTC(year, month, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const lead = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const ym = year * 12 + month;
    const [ty, tm] = today.split('-').map(Number);

    let cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<div class="cal-weekday">${d}</div>`).join('');
    for (let i = 0; i < lead; i++) cells += '<div class="calendar-day blank"></div>';
    for (let d = 1; d <= days; d++) {
        const date = ymd(year, month, d);
        const weekday = WEEKDAYS[(new Date(Date.UTC(year, month, d)).getUTCDay() + 6) % 7];
        const blocks = state.timeOff.filter((t) => t.startDate <= date && t.endDate >= date);
        const booked = active.filter((b) => dateKey(b.date) === date).length;
        let cls = 'free', title = '';
        if (date < today) cls = 'past';
        else if (blocks.some((t) => t.allDay) || avail[weekday] === false) { cls = 'chef-off'; title = 'Not available'; }
        else if (booked) { cls = 'chef-booked'; title = `${booked} booking(s)`; }
        else if (blocks.length) { cls = 'partial'; title = 'Part of the day blocked'; }
        cells += `<button type="button" class="calendar-day ${cls}" title="${esc(title)}" ${date < today ? 'disabled' : ''} data-action="chefCalPick" data-date="${date}">${d}</button>`;
    }
    $('chefCalendar').innerHTML = `<div class="cal-head">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-action="chefCalPrev" ${ym <= ty * 12 + tm - 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>
        <span class="cal-title">${esc(monthName)}</span>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-action="chefCalNext"><i class="fas fa-chevron-right"></i></button>
        </div><div class="cal-grid">${cells}</div>`;
}

function chefCalMove(delta) {
    const total = state.chefCal.year * 12 + state.chefCal.month + delta;
    state.chefCal = { year: Math.floor(total / 12), month: total % 12 };
    renderChefCalendar();
}

/* ---- profile tab ---- */
function renderProfile() {
    const chef = state.chef;
    const c = getCountry(chef.serviceLocation.country);
    $('profilePanel').innerHTML = `<form id="profileForm" class="card"><div class="card-body">
        <h5 class="card-title">Your public profile</h5>
        <p class="text-muted small">Country: <strong>${esc(c.name)}</strong> (prices in ${esc(c.currency)}). To change your country, contact support.</p>
        <div class="mb-3"><label class="form-label" for="pfBio">Bio</label><textarea class="form-control" id="pfBio" rows="3" maxlength="500" required>${esc(chef.bio)}</textarea></div>
        <div class="row g-2 mb-3"><div class="col-md-6"><label class="form-label" for="pfAdditionalCuisines">Other cuisines you cook</label><input class="form-control" id="pfAdditionalCuisines" maxlength="240" value="${esc((chef.additionalCuisines || []).join(', '))}" placeholder="Swahili, Ethiopian"></div><div class="col-md-6"><label class="form-label" for="pfSignatureDishes">Signature dishes</label><input class="form-control" id="pfSignatureDishes" maxlength="320" value="${esc((chef.signatureDishes || []).join(', '))}" placeholder="Coconut fish curry, pilau"></div></div>
        <div class="mb-3"><label class="form-label" for="pfProfileImage">Profile photo link</label><input type="url" class="form-control" id="pfProfileImage" maxlength="500" value="${esc(chef.profileImage || '')}" placeholder="https://…"><div class="form-text">Use a direct HTTPS image link. This photo appears on your public chef profile.</div></div>
        <div class="row g-2 mb-3">
            <div class="col-md-4"><label class="form-label" for="pfRate">Hourly rate (${esc(c.currency)})</label>
                <input type="number" class="form-control" id="pfRate" min="${esc(c.minHourlyRate)}" step="any" value="${esc(chef.hourlyRate)}" required>
                <div class="form-text">Minimum ${esc(money(c.minHourlyRate, c))}</div></div>
            <div class="col-md-4"><label class="form-label" for="pfCity">City / Town</label><input type="text" class="form-control" id="pfCity" value="${esc(chef.serviceLocation.city)}" required></div>
            <div class="col-md-4"><label class="form-label" for="pfRegion">${esc(c.regionLabel)}</label><input type="text" class="form-control" id="pfRegion" value="${esc(chef.serviceLocation.state)}"></div>
        </div>
        <p class="mb-1"><strong>Cuisine:</strong> ${esc(chef.cuisineSpecialization)} &nbsp; <strong>Experience:</strong> ${esc(chef.experience)} years &nbsp; <strong>Rating:</strong> ${chef.rating && chef.rating.count ? esc(chef.rating.average) + ' (' + esc(chef.rating.count) + ')' : 'no reviews yet'}</p>
        <button type="submit" class="btn btn-primary mt-2">Save profile</button>
    </div></form>`;
}

formHandlers.profileForm = async () => {
    const c = getCountry(state.chef.serviceLocation.country);
    const rate = Number($('pfRate').value);
    if (rate < c.minHourlyRate) { notify(`The minimum hourly rate in ${c.name} is ${money(c.minHourlyRate, c)}.`, 'warning'); return; }
    const r = await guard(() => api.chefs.update(state.chef._id, {
        bio: $('pfBio').value.trim(), hourlyRate: rate,
        additionalCuisines: $('pfAdditionalCuisines').value.split(',').map((item) => item.trim()).filter(Boolean),
        signatureDishes: $('pfSignatureDishes').value.split(',').map((item) => item.trim()).filter(Boolean),
        profileImage: $('pfProfileImage').value.trim(),
        serviceLocation: { city: $('pfCity').value.trim(), state: $('pfRegion').value.trim() }
    }));
    if (!r) return;
    notify('Profile saved.');
    loadChefDashboard();
};

/* ---------------------------------- 8. admin --------------------------------- */
const callButtons = (phone) => {
    if (!phone) return '<span class="text-muted">No phone number</span>';
    const digits = String(phone).replace(/\D/g, '');
    return `<a class="btn btn-sm btn-success me-1" href="tel:${esc(phone)}"><i class="fas fa-phone me-1"></i>Call ${esc(phone)}</a>
        <a class="btn btn-sm btn-outline-success" href="https://wa.me/${esc(digits)}" target="_blank" rel="noopener"><i class="fab fa-whatsapp me-1"></i>WhatsApp</a>`;
};

async function loadAdminPage() {
    const sid = sessionId;
    const box = $('adminChefList');
    box.innerHTML = '<div class="text-center text-muted py-5">Loading applications…</div>';
    const r = await guard(() => api.admin.pendingChefs());
    if (sid !== sessionId) return;
    if (!r) { box.innerHTML = ''; return; }
    state.adminChefs = r.data;
    renderAdminList();
}

function renderAdminList() {
    const box = $('adminChefList');
    if (!state.adminChefs.length) { box.innerHTML = '<div class="alert alert-light border">No chefs are waiting for a decision. 🎉</div>'; return; }
    box.innerHTML = state.adminChefs.map(adminCard).join('');
}

function adminCard(chef) {
    const u = chef.user || {};
    const app = chef.application;
    const c = getCountry(chef.serviceLocation && chef.serviceLocation.country);
    const tz = c.timezone;
    const iv = (app && app.interview) || { status: 'pending' };
    const passed = iv.outcome === 'passed';
    const id = esc(chef._id);

    let ivText;
    if (!app) ivText = '<span class="badge bg-secondary">No application yet</span>';
    else if (passed) ivText = '<span class="badge bg-success">Interview passed</span>';
    else if (iv.status === 'scheduled') ivText = `<span class="badge bg-primary">Interview scheduled</span> ${esc(fmtDateTime(iv.scheduledAt, tz))}${iv.meetingLink ? ` · <a href="${esc(iv.meetingLink)}" target="_blank" rel="noopener">meeting link</a>` : ''}`;
    else ivText = '<span class="badge bg-warning text-dark">Interview not held yet</span>';

    const answers = app && app.answers && app.answers.length
        ? `<details class="mt-3"><summary>Interview answers (${app.answers.length})</summary>${app.answers.map((a) => `<p class="mb-1 mt-2"><strong>${esc(a.question)}</strong><br>${esc(a.answer)}</p>`).join('')}</details>` : '';
    const docs = app ? `<button class="btn btn-sm btn-outline-secondary me-1" data-action="adminDoc" data-id="${id}" data-type="passportPhoto"><i class="far fa-id-card me-1"></i>Passport / ID</button>
        ${app.certificate ? `<button class="btn btn-sm btn-outline-secondary" data-action="adminDoc" data-id="${id}" data-type="certificate"><i class="fas fa-certificate me-1"></i>Certificate</button>` : ''}` : '';

    const canSchedule = app && iv.status !== 'completed';
    const buttons = `
        <button class="btn btn-sm btn-primary me-1 mb-1" data-action="adminSchedule" data-id="${id}" ${canSchedule ? '' : 'disabled'}><i class="far fa-calendar-plus me-1"></i>${iv.status === 'scheduled' ? 'Reschedule interview' : 'Schedule interview'}</button>
        <button class="btn btn-sm btn-outline-primary me-1 mb-1" data-action="adminInterviewDone" data-id="${id}" ${canSchedule ? '' : 'disabled'}><i class="fas fa-clipboard-check me-1"></i>Record interview result</button>
        <button class="btn btn-sm btn-success me-1 mb-1" data-action="adminApprove" data-id="${id}" ${passed ? '' : 'disabled'} title="${passed ? '' : 'The chef must pass the live interview first'}"><i class="fas fa-check me-1"></i>Approve</button>
        <button class="btn btn-sm btn-outline-danger mb-1" data-action="adminReject" data-id="${id}"><i class="fas fa-xmark me-1"></i>Reject</button>
        ${passed ? '' : '<div class="form-text">Approval unlocks after the live interview is passed.</div>'}`;

    return `<div class="admin-card">
        <div class="d-flex justify-content-between flex-wrap gap-2">
            <div>
                <h5 class="mb-0">${esc(u.firstName)} ${esc(u.lastName)}</h5>
                <div class="text-muted small">${esc(u.email)}</div>
            </div>
            <div class="text-end small text-muted">${esc(chef.cuisineSpecialization)} · ${esc(chef.experience)} yrs<br>${esc(chef.serviceLocation.city)}, ${esc(c.name)} · ${esc(money(chef.hourlyRate, c))}/h</div>
        </div>
        <p class="mt-3 mb-2">${esc(chef.bio)}</p>
        <div class="mb-2"><strong>Phone for the interview:</strong> ${callButtons(app && app.phone)}</div>
        ${app && app.preferredInterviewTimes ? `<div class="small text-muted mb-2">Free for interview: ${esc(app.preferredInterviewTimes)}</div>` : ''}
        <div class="mb-2"><strong>Interview:</strong> ${ivText}</div>
        ${iv.notes ? `<div class="small text-muted mb-2">Your notes: ${esc(iv.notes)}</div>` : ''}
        <div class="mb-2">${docs}</div>
        ${answers}
        <div class="mt-3">${buttons}</div>
    </div>`;
}

async function openAdminDoc(id, type) {
    const w = window.open('', '_blank'); // opened first so the browser does not block the pop-up
    try {
        const url = await api.admin.documentBlobUrl(id, type);
        if (w) w.location = url; else window.location = url;
    } catch (e) {
        if (w) w.close();
        notify(e.message, 'danger');
    }
}

const adminChef = (id) => state.adminChefs.find((c) => c._id === id);
const chefInfoHtml = (chef) => `<div class="p-2 bg-light rounded"><strong>${esc(chef.user.firstName)} ${esc(chef.user.lastName)}</strong><div class="mt-1">${callButtons(chef.application && chef.application.phone)}</div></div>`;

function openSchedule(id) {
    const chef = adminChef(id);
    $('schedChefId').value = id;
    $('schedChefInfo').innerHTML = chefInfoHtml(chef);
    const iv = chef.application && chef.application.interview;
    $('schedLink').value = (iv && iv.meetingLink) || '';
    const next = new Date(Date.now() + 86400000);
    next.setMinutes(0, 0, 0);
    const local = new Date(next.getTime() - next.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('schedWhen').min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('schedWhen').value = local;
    modal('scheduleModal').show();
}

formHandlers.scheduleForm = async () => {
    const when = new Date($('schedWhen').value);
    if (isNaN(when)) { notify('Choose a date and time.', 'warning'); return; }
    const r = await guard(() => api.admin.scheduleInterview($('schedChefId').value, when.toISOString(), $('schedLink').value.trim() || undefined));
    if (!r) return;
    hideModal('scheduleModal');
    notify('Interview scheduled. The chef has been emailed.');
    loadAdminPage();
};

function openInterviewDone(id) {
    const chef = adminChef(id);
    $('ivChefId').value = id;
    $('ivChefInfo').innerHTML = chefInfoHtml(chef);
    $('ivPassedYes').checked = true;
    $('ivNotes').value = '';
    $('ivReason').value = '';
    $('ivReasonBox').style.display = 'none';
    modal('interviewDoneModal').show();
}

formHandlers.interviewDoneForm = async () => {
    const passed = $('ivPassedYes').checked;
    if (!passed && !confirm('This will reject the application and email the chef. Continue?')) return;
    const r = await guard(() => api.admin.completeInterview($('ivChefId').value, passed, $('ivNotes').value.trim() || undefined, $('ivReason').value.trim() || undefined));
    if (!r) return;
    hideModal('interviewDoneModal');
    notify(r.message || 'Result saved.');
    loadAdminPage();
};

async function approveChef(id) {
    const chef = adminChef(id);
    if (!confirm(`Approve ${chef.user.firstName} ${chef.user.lastName}? Their profile will go live immediately.`)) return;
    const r = await guard(() => api.admin.verifyChef(id, true));
    if (!r) return;
    notify('Chef approved and notified.');
    loadAdminPage();
}

formHandlers.adminRejectForm = async () => {
    const r = await guard(() => api.admin.verifyChef($('arChefId').value, false, $('arReason').value.trim()));
    if (!r) return;
    hideModal('adminRejectModal');
    notify('Application rejected. The chef was emailed.');
    loadAdminPage();
};

/* ------------------------------ food ordering: shared ------------------------------ */
const ORDER_STATUS = {
    pending: ['warning text-dark', 'Waiting for the chef'], accepted: ['primary', 'Accepted'], preparing: ['primary', 'Being prepared'],
    ready: ['success', 'Ready'], completed: ['info text-dark', 'Completed'], rejected: ['danger', 'Declined'], cancelled: ['secondary', 'Cancelled']
};
const orderBadge = (s) => { const [c, l] = ORDER_STATUS[s] || ['secondary', s]; return `<span class="badge bg-${c}">${esc(l)}</span>`; };
const FALLBACK_META = { cuisines: ['Kenyan', 'Italian', 'French', 'Asian', 'Mexican', 'Indian', 'Mediterranean', 'American', 'Other'], categories: [{ code: 'main', label: 'Main dishes' }], dietary: [], courierServices: [{ code: 'other', label: 'Other delivery service' }], orderReasons: [{ code: 'other', label: 'Other' }] };

async function loadMeta() {
    if (state.meta) return state.meta;
    try { state.meta = (await api.kitchens.meta()).data; } catch (e) { state.meta = FALLBACK_META; }
    return state.meta;
}
const metaLabel = (list, code) => ((list || []).find((x) => x.code === code) || {}).label || code;
const orderReasonLabel = (code) => (code === 'customer_cancelled' ? 'Cancelled by the customer' : metaLabel(state.meta && state.meta.orderReasons, code));
const addOption = (sel, value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o); };
const dialOptions = (selected) => state.countries.map((c) => `<option value="${esc(c.dialCode)}" ${c.dialCode === selected ? 'selected' : ''}>${esc(c.dialCode)} (${esc(c.name)})</option>`).join('');
const clock = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeStyle: 'short' }).format(new Date(iso));
const itemsList = (o) => `<ul class="mb-1 ps-3">${o.items.map((i) => `<li>${esc(i.quantity)} × ${esc(i.name)}${i.note ? ` <em class="text-muted">(${esc(i.note)})</em>` : ''}</li>`).join('')}</ul>`;
const courierHtml = (c) => {
    if (!c || !c.service) return '';
    const label = metaLabel(state.meta && state.meta.courierServices, c.service);
    return `<div class="info-box"><i class="fas fa-motorcycle me-1"></i><strong>${esc(label)} rider</strong>${c.riderName ? ` · ${esc(c.riderName)}` : ''}${c.riderPhone ? ` · <a href="tel:${esc(c.riderPhone)}">${esc(c.riderPhone)}</a>` : ''}${c.trackingLink ? ` · <a href="${esc(c.trackingLink)}" target="_blank" rel="noopener">Track delivery</a>` : ''}</div>`;
};

/* ------------------------------ food ordering: customer ------------------------------ */
async function loadOrderFoodPage() {
    const meta = await loadMeta();
    $('orderCountryName').textContent = getCountry().name;
    const cu = $('searchCuisine'), di = $('searchDietary');
    if (cu.options.length <= 1) meta.cuisines.forEach((x) => addOption(cu, x, x));
    if (di.options.length <= 1) meta.dietary.forEach((d) => addOption(di, d.code, d.label));
    if (state.homeOrderSearch) {
        $('searchCity').value = state.homeOrderSearch.city;
        $('searchArea').value = '';
        cu.value = state.homeOrderSearch.cuisine;
        state.homeOrderSearch = null;
    } else {
        if (!$('searchCity').value) $('searchCity').value = localStorage.getItem('orderCity') || '';
        if (!$('searchArea').value) $('searchArea').value = localStorage.getItem('orderArea') || '';
    }
    await searchKitchens();
}

async function searchKitchens() {
    const c = getCountry();
    const params = { country: c.code, city: $('searchCity').value.trim(), area: $('searchArea').value.trim(), cuisine: $('searchCuisine').value, dietary: $('searchDietary').value };
    localStorage.setItem('orderCity', params.city);
    localStorage.setItem('orderArea', params.area);
    $('orderCountryName').textContent = c.name;
    $('kitchenList').innerHTML = '<div class="col-12 text-center text-muted py-5">Looking for kitchens…</div>';
    const r = await guard(() => api.kitchens.list(params));
    state.kitchens = r ? r.data : [];
    renderKitchenList();
}

function renderKitchenList() {
    const box = $('kitchenList');
    if (!state.kitchens.length) {
        box.innerHTML = `<div class="col-12"><div class="alert alert-light border">No kitchens found in ${esc(getCountry().name)} for that search yet. Try a bigger area, another cuisine, or another country.</div></div>`;
        return;
    }
    box.innerHTML = state.kitchens.map((k) => {
        const c = getCountry(k.country);
        const areas = k.deliveryAreas.length
            ? `Delivers to ${k.deliveryAreas.slice(0, 4).map(esc).join(', ')}${k.deliveryAreas.length > 4 ? ` +${k.deliveryAreas.length - 4} more` : ''}`
            : `Delivers within ${esc(k.city)}`;
        const rating = k.rating && k.rating.count ? `${stars(k.rating.average)} <small class="text-muted">${esc(k.rating.average)} (${esc(k.rating.count)})</small>` : '<small class="text-muted">New kitchen</small>';
        return `<div class="col-md-6 col-lg-4"><div class="kitchen-card ${k.acceptingOrders ? '' : 'closed'}">
            ${k.cover ? `<img class="kitchen-cover" src="${esc(imgSrc(k.cover))}" alt="${esc(k.kitchenName)}" loading="lazy">` : ''}
            <div class="d-flex justify-content-between align-items-start gap-2"><h5 class="mb-1">${esc(k.kitchenName)}</h5>
                ${k.acceptingOrders ? '<span class="badge bg-success">Open</span>' : '<span class="badge bg-secondary">Closed</span>'}</div>
            <div class="small text-muted mb-1">Chef ${esc(k.chefName)} · ${esc(k.city)}</div>
            <div class="mb-2">${rating}</div>
            ${k.tagline ? `<p class="small mb-2">${esc(k.tagline)}</p>` : ''}
            <div class="mb-2">${k.cuisines.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>
            <div class="small text-muted mb-1"><i class="fas fa-location-dot me-1"></i>${areas}</div>
            <div class="small mb-1"><strong>${esc(money(k.priceFrom, c))}</strong>${k.priceTo > k.priceFrom ? ` – ${esc(money(k.priceTo, c))}` : ''} · ${esc(k.mealCount)} meal${k.mealCount === 1 ? '' : 's'}</div>
            <div class="small text-muted mb-3">${k.fulfilment.pickup ? '<i class="fas fa-store me-1"></i>Pickup ' : ''}${k.fulfilment.courier ? '<i class="fas fa-motorcycle ms-2 me-1"></i>Rider delivery' : ''}${k.minOrder ? ` · Min ${esc(money(k.minOrder, c))}` : ''}</div>
            <button class="btn btn-primary btn-sm w-100" data-action="openKitchen" data-id="${esc(k.chefId)}">View menu</button>
        </div></div>`;
    }).join('');
}

async function openKitchen(chefId) {
    await loadMeta();
    showPage('kitchenPage');
    $('kitchenBody').innerHTML = '<div class="text-center text-muted py-5">Loading the menu…</div>';
    const r = await guard(() => api.kitchens.get(chefId));
    if (!r) { showPage('orderFoodPage'); return; }
    state.currentKitchen = r.data;
    renderKitchen();
}

const cartLines = () => {
    const k = state.currentKitchen;
    if (!k || state.cart.chefId !== k.chefId) return [];
    return k.meals.filter((m) => state.cart.items[m.id]).map((m) => ({ meal: m, qty: state.cart.items[m.id].qty }));
};
const cartTotal = () => cartLines().reduce((sum, l) => sum + l.meal.price * l.qty, 0);

function renderKitchen() {
    const k = state.currentKitchen;
    const c = getCountry(k.country);
    const cats = (state.meta.categories.length ? state.meta.categories : [{ code: 'main', label: 'Meals' }]);
    const sections = cats.map((cat) => {
        const meals = k.meals.filter((m) => m.category === cat.code);
        if (!meals.length) return '';
        return `<h5 class="mt-4">${esc(cat.label)}</h5>` + meals.map((m) => {
            const qty = (state.cart.chefId === k.chefId && state.cart.items[m.id]) ? state.cart.items[m.id].qty : 0;
            return `<div class="meal-row">
                <div class="d-flex gap-3">${mealPhotoHtml(m)}<div><strong>${esc(m.name)}</strong>${m.portion ? ` <span class="text-muted small">· ${esc(m.portion)}</span>` : ''}
                    ${m.description ? `<div class="small text-muted">${esc(m.description)}</div>` : ''}
                    <div class="mt-1">${m.dietary.map((d) => `<span class="chip">${esc(metaLabel(state.meta.dietary, d))}</span>`).join('')}<span class="chip warn">~${esc(m.prepMinutes)} min</span></div><div class="d-flex gap-2 mt-2"><button class="btn btn-sm btn-outline-secondary" data-action="toggleInteraction" data-kind="like" data-type="meal" data-id="${esc(m.id)}"><i class="far fa-heart"></i> <span>Like</span> <b>0</b></button><button class="btn btn-sm btn-outline-secondary" data-action="toggleInteraction" data-kind="save" data-type="meal" data-id="${esc(m.id)}"><i class="far fa-bookmark"></i> <span>Save</span></button></div></div></div>
                <div class="text-end"><div class="mb-2"><strong>${esc(money(m.price, c))}</strong></div>
                    <div class="qty"><button type="button" data-action="cartSub" data-id="${esc(m.id)}" ${qty ? '' : 'disabled'}>−</button><span>${qty}</span>
                    <button type="button" data-action="cartAdd" data-id="${esc(m.id)}" ${k.acceptingOrders ? '' : 'disabled'}>+</button></div></div>
            </div>`;
        }).join('');
    }).join('');

    const how = [];
    if (k.fulfilment.courier) how.push(k.courierArrangedBy === 'chef' ? 'A rider (Bolt, Uber or another delivery app) is booked by the chef' : 'You book a rider from a delivery app of your choice');
    if (k.fulfilment.pickup) how.push('Pickup from the kitchen');
    const rating = k.rating && k.rating.count ? `${stars(k.rating.average)} <small class="text-muted">${esc(k.rating.average)} (${esc(k.rating.count)})</small>` : '';
    $('kitchenBody').innerHTML = `
        <div class="mb-3"><h2 class="mb-1">${esc(k.kitchenName)}</h2>
            ${k.tagline ? `<p class="lead mb-1">${esc(k.tagline)}</p>` : ''}
            <div class="text-muted">Chef ${esc(k.chefName)} · ${esc(k.city)} ${rating}</div>
            <div class="small text-muted mt-1"><i class="fas fa-location-dot me-1"></i>${k.deliveryAreas.length ? `Delivers to ${k.deliveryAreas.map(esc).join(', ')}` : `Delivers within ${esc(k.city)}`}</div>
            <div class="info-box"><i class="fas fa-circle-info me-1"></i>${how.map(esc).join(' · ')}. Payment is arranged directly with the chef.</div>
            ${k.acceptingOrders ? '' : '<div class="alert alert-secondary mt-2 mb-0">This kitchen is closed for orders right now. You can look at the menu.</div>'}</div>
        <div class="row g-4"><div class="col-lg-8">${sections}</div><div class="col-lg-4"><div class="cart-box" id="cartBox">${cartHtml()}</div></div></div>`;
    hydrateInteractions('meal', k.meals.map((meal) => meal.id));
}

function cartHtml() {
    const k = state.currentKitchen, c = getCountry(k.country), lines = cartLines(), total = cartTotal();
    if (!lines.length) return '<h5>Your order</h5><p class="text-muted mb-0">Add meals from the menu.</p>';
    const short = k.minOrder && total < k.minOrder;
    return `<h5>Your order</h5>${lines.map((l) => `<div class="d-flex justify-content-between small mb-1"><span>${esc(l.qty)} × ${esc(l.meal.name)}</span><span>${esc(money(l.meal.price * l.qty, c))}</span></div>`).join('')}
        <hr class="my-2"><div class="d-flex justify-content-between"><strong>Total</strong><strong>${esc(money(total, c))}</strong></div>
        ${short ? `<div class="small text-danger mt-2">Minimum order: ${esc(money(k.minOrder, c))}. Add ${esc(money(k.minOrder - total, c))} more.</div>` : ''}
        <button class="btn btn-primary w-100 mt-3" data-action="checkout" ${short || !k.acceptingOrders ? 'disabled' : ''}>Checkout</button>`;
}

function cartChange(mealId, delta) {
    const k = state.currentKitchen;
    if (state.cart.chefId && state.cart.chefId !== k.chefId) {
        if (!confirm('Your cart has meals from another kitchen. Start a new cart here?')) return;
        state.cart = { chefId: null, items: {} };
    }
    state.cart.chefId = k.chefId;
    const cur = state.cart.items[mealId] || { qty: 0 };
    const qty = Math.max(0, Math.min(20, cur.qty + delta));
    if (qty === 0) delete state.cart.items[mealId]; else state.cart.items[mealId] = { qty };
    if (!Object.keys(state.cart.items).length) state.cart.chefId = null;
    renderKitchen();
}

async function startCheckout() {
    if (!state.user) {
        notify('Please log in or create an account to order.', 'info');
        state.returnTo = 'kitchenPage';
        showPage('customerAuthPage');
        return;
    }
    if (state.user.role !== 'customer') { notify('Only customer accounts can order food.', 'warning'); return; }
    if (!(await ensureVerified())) return;
    const k = state.currentKitchen, c = getCountry(k.country);
    const pre = JSON.parse(localStorage.getItem('orderPrefill') || '{}');
    $('coKitchen').textContent = k.kitchenName;
    $('coDial').innerHTML = dialOptions(pre.dial || c.dialCode);
    $('coPhone').value = pre.phone || '';
    $('coStreet').value = pre.street || '';
    $('coArea').value = pre.area || localStorage.getItem('orderArea') || '';
    $('coCity').value = pre.city || localStorage.getItem('orderCity') || '';
    $('coRegion').value = pre.region || '';
    $('coPostal').value = pre.postal || '';
    $('coInstructions').value = ''; $('coNotes').value = '';
    $('coRegionLabel').textContent = c.regionLabel + (c.regionRequired ? '' : ' (optional)');
    $('coPostalLabel').textContent = c.postalLabel + (c.postalRequired ? '' : ' (optional)');
    $('coDeliveryWrap').style.display = k.fulfilment.courier ? 'block' : 'none';
    $('coPickupWrap').style.display = k.fulfilment.pickup ? 'block' : 'none';
    $('coDelivery').checked = k.fulfilment.courier;
    $('coPickup').checked = !k.fulfilment.courier;
    updateCheckoutView();
    modal('checkoutModal').show();
}

function updateCheckoutView() {
    const k = state.currentKitchen, c = getCountry(k.country), delivery = $('coDelivery').checked;
    $('coDeliveryBox').style.display = delivery ? 'block' : 'none';
    $('coCourierNote').textContent = delivery
        ? (k.courierArrangedBy === 'chef'
            ? 'After the chef accepts, they book a rider (Bolt, Uber or another delivery app) and share the rider details with you here.'
            : 'After the chef accepts, you get the kitchen address so you can book your own rider (Bolt, Uber or any delivery app) and add the rider details here.')
        : 'After the chef accepts, you get the kitchen address and phone number to collect your order.';
    $('coSummary').innerHTML = cartLines().map((l) => `<div class="d-flex justify-content-between"><span>${esc(l.qty)} × ${esc(l.meal.name)}</span><span>${esc(money(l.meal.price * l.qty, c))}</span></div>`).join('')
        + `<hr class="my-2"><div class="d-flex justify-content-between"><strong>Total</strong><strong>${esc(money(cartTotal(), c))}</strong></div>`;
}

formHandlers.homeSearchForm = async () => { await submitHomeSearch(); };
formHandlers.kitchenSearchForm = () => searchKitchens();

formHandlers.checkoutForm = async () => {
    const k = state.currentKitchen, c = getCountry(k.country);
    const v = (id) => $(id).value.trim();
    const delivery = $('coDelivery').checked;
    const phone = buildPhone($('coDial').value, $('coPhone').value);
    const problems = [];
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) problems.push('Enter your phone number.');
    if (delivery) {
        if (!v('coStreet')) problems.push('Enter the street or building.');
        if (!v('coCity')) problems.push('Enter the city or town.');
        if (c.regionRequired && !v('coRegion')) problems.push(`Enter the ${c.regionLabel.toLowerCase()}.`);
        if (c.postalRequired && !v('coPostal')) problems.push(`Enter the ${c.postalLabel.toLowerCase()}.`);
    }
    if (problems.length) { notify(problems[0], 'warning'); return; }

    const payload = {
        chefId: k.chefId, fulfilment: delivery ? 'delivery' : 'pickup', phone, notes: v('coNotes') || undefined,
        items: cartLines().map((l) => ({ mealId: l.meal.id, quantity: l.qty }))
    };
    if (delivery) payload.dropoff = { street: v('coStreet'), area: v('coArea'), city: v('coCity'), state: v('coRegion'), zipCode: v('coPostal'), country: c.code, instructions: v('coInstructions') || undefined };
    const r = await guard(() => api.orders.create(payload));
    if (!r) return;
    localStorage.setItem('orderPrefill', JSON.stringify({ dial: $('coDial').value, phone: $('coPhone').value.trim(), street: v('coStreet'), area: v('coArea'), city: v('coCity'), region: v('coRegion'), postal: v('coPostal') }));
    state.cart = { chefId: null, items: {} };
    hideModal('checkoutModal');
    notify(`Order ${r.data.code} sent to ${k.kitchenName}! You will be emailed when the chef responds.`);
    showPage('myBookingsPage');
    bootstrap.Tab.getOrCreateInstance($('custTabOrdersBtn')).show();
};

async function loadMyOrders() {
    const sid = sessionId;
    await loadMeta();
    const r = await guard(() => api.orders.list(), { quiet: true });
    if (sid !== sessionId || !r) return;
    state.myOrders = r.data;
    renderMyOrders();
}

function renderMyOrders() {
    const box = $('myOrdersList');
    const active = state.myOrders.filter((o) => ['pending', 'accepted', 'preparing', 'ready'].includes(o.status)).length;
    $('activeOrdersCount').style.display = active ? 'inline-block' : 'none';
    $('activeOrdersCount').textContent = active;
    if (!state.myOrders.length) { box.innerHTML = '<div class="alert alert-light border">No food orders yet. <a href="#" data-action="goPage" data-page="orderFoodPage">Find a kitchen near you</a>.</div>'; return; }
    box.innerHTML = state.myOrders.map((o) => {
        const c = getCountry(o.country), tz = c.timezone, live = ['accepted', 'preparing', 'ready'].includes(o.status);
        const where = o.fulfilment === 'delivery' ? `Delivery to ${[o.dropoff && o.dropoff.area, o.dropoff && o.dropoff.city].filter(Boolean).join(', ')}` : 'Pickup';
        let extra = '';
        if ((o.status === 'rejected' || o.status === 'cancelled') && o.statusReason) {
            extra += `<div class="reason-box"><strong>${o.status === 'rejected' ? 'Declined by the kitchen' : 'Cancelled'}:</strong> ${esc(orderReasonLabel(o.statusReason.code))}${o.statusReason.note ? `<br><em>"${esc(o.statusReason.note)}"</em>` : ''}</div>`;
        }
        if (live && o.readyAt && o.status !== 'ready') extra += `<div class="info-box"><i class="far fa-clock me-1"></i>Ready around <strong>${esc(clock(o.readyAt, tz))}</strong></div>`;
        if (o.status === 'ready' && o.fulfilment === 'pickup') extra += '<div class="info-box"><i class="fas fa-bag-shopping me-1"></i>Your order is ready to collect.</div>';
        if (o.pickup) {
            const text = `${o.pickup.kitchenName}, ${o.pickup.address}. Phone ${o.pickup.phone}. Order ${o.code}`;
            extra += `<div class="info-box"><strong><i class="fas fa-location-dot me-1"></i>Collect from:</strong> ${esc(o.pickup.address)}<br><strong>Kitchen phone:</strong> <a href="tel:${esc(o.pickup.phone)}">${esc(o.pickup.phone)}</a> · <strong>Order code:</strong> <span class="code">${esc(o.code)}</span>
                <button class="btn btn-sm btn-outline-secondary ms-2" data-action="copyText" data-text="${esc(text)}"><i class="far fa-copy me-1"></i>Copy</button></div>`;
        }
        if (o.fulfilment === 'delivery' && live) {
            extra += courierHtml(o.courier);
            if (!o.courier.service && o.courier.arrangedBy === 'chef') extra += '<div class="info-box"><i class="fas fa-motorcycle me-1"></i>The chef will book a rider and the details will appear here.</div>';
            if (o.courier.arrangedBy === 'customer') extra += `<div class="mt-2"><button class="btn btn-sm btn-outline-primary" data-action="orderCourier" data-id="${esc(o._id)}"><i class="fas fa-motorcycle me-1"></i>${o.courier.service ? 'Edit' : 'Add'} my rider details</button></div>`;
        }
        if (o.fulfilment === 'delivery' && o.status === 'completed') extra += courierHtml(o.courier);
        const cancel = o.status === 'pending' ? `<button class="btn btn-sm btn-outline-danger mt-2" data-action="cancelOrder" data-id="${esc(o._id)}">Cancel order</button>` : '';
        return `<div class="order-card">
            <div class="d-flex justify-content-between flex-wrap gap-2">
                <div><span class="code">${esc(o.code)}</span> · <strong>${esc((o.chef && o.chef.kitchenName) || 'Kitchen')}</strong>
                    <div class="small text-muted">${esc(new Date(o.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }))} · ${esc(where)}</div></div>
                <div class="text-end">${orderBadge(o.status)}<div class="mt-1"><strong>${esc(money(o.subtotal, c))}</strong></div></div>
            </div>
            <div class="mt-2">${itemsList(o)}</div>${o.notes ? `<div class="small text-muted">Your note: ${esc(o.notes)}</div>` : ''}${extra}${cancel}
        </div>`;
    }).join('');
}

async function cancelMyOrder(id) {
    if (!confirm('Cancel this order?')) return;
    const r = await guard(() => api.orders.updateStatus(id, 'cancelled'));
    if (!r) return;
    notify('Order cancelled.', 'info');
    loadMyOrders();
}

function copyText(text) {
    const done = () => notify('Copied. You can paste it into the delivery app.', 'info');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => notify(text, 'info'));
    else notify(text, 'info');
}

/* rider details: the chef OR the customer fills this in (whoever books the rider) */
function openCourier(order) {
    const meta = state.meta;
    $('courierOrderId').value = order._id;
    $('courierCode').textContent = order.code;
    $('courierDial').value = getCountry(order.country).dialCode;
    $('courierService').innerHTML = '';
    meta.courierServices.forEach((s) => addOption($('courierService'), s.code, s.label));
    $('courierService').value = (order.courier && order.courier.service) || meta.courierServices[0].code;
    $('courierRider').value = (order.courier && order.courier.riderName) || '';
    $('courierPhone').value = (order.courier && order.courier.riderPhone) || '';
    $('courierLink').value = (order.courier && order.courier.trackingLink) || '';
    modal('courierModal').show();
}

formHandlers.courierForm = async () => {
    const phoneRaw = $('courierPhone').value.trim();
    const r = await guard(() => api.orders.setCourier($('courierOrderId').value, {
        service: $('courierService').value, riderName: $('courierRider').value.trim(),
        riderPhone: phoneRaw ? buildPhone($('courierDial').value, phoneRaw) : '', trackingLink: $('courierLink').value.trim()
    }));
    if (!r) return;
    hideModal('courierModal');
    notify('Rider details saved. The other person was emailed.');
    if (state.user.role === 'chef') refreshChefOrders(); else loadMyOrders();
};

/* ------------------------------ food ordering: chef ------------------------------ */
async function refreshChefOrders() {
    const sid = sessionId;
    const r = await guard(() => api.orders.list(), { quiet: true });
    if (sid !== sessionId || !r) return;
    state.chefOrders = r.data;
    renderChefOrders();
}

function renderChefOrders() {
    const box = $('chefOrdersList');
    const rank = (o) => (o.status === 'pending' ? 0 : ['accepted', 'preparing', 'ready'].includes(o.status) ? 1 : 2);
    const list = [...state.chefOrders].sort((a, b) => rank(a) - rank(b) || new Date(b.createdAt) - new Date(a.createdAt));
    const pending = list.filter((o) => o.status === 'pending').length;
    $('pendingOrdersCount').style.display = pending ? 'inline-block' : 'none';
    $('pendingOrdersCount').textContent = pending;
    if (!list.length) {
        box.innerHTML = `<div class="alert alert-light border">No food orders yet. ${state.kitchenSettings && state.kitchenSettings.enabled ? 'They will appear here.' : 'Open your kitchen in the "Kitchen &amp; meals" tab to start receiving orders.'}</div>`;
        return;
    }
    box.innerHTML = list.map((o) => {
        const c = getCountry(o.country), tz = c.timezone;
        const live = ['accepted', 'preparing', 'ready'].includes(o.status);
        const id = esc(o._id);
        let actions = '';
        if (o.status === 'pending') actions = `<button class="btn btn-success btn-sm me-2" data-action="orderAccept" data-id="${id}"><i class="fas fa-check me-1"></i>Accept</button><button class="btn btn-outline-danger btn-sm" data-action="orderReject" data-id="${id}" data-mode="rejected"><i class="fas fa-xmark me-1"></i>Decline</button>`;
        if (o.status === 'accepted') actions = `<button class="btn btn-primary btn-sm me-2" data-action="orderStatus" data-id="${id}" data-status="preparing">Start preparing</button><button class="btn btn-success btn-sm me-2" data-action="orderStatus" data-id="${id}" data-status="ready">Ready</button>`;
        if (o.status === 'preparing') actions = `<button class="btn btn-success btn-sm me-2" data-action="orderStatus" data-id="${id}" data-status="ready">Ready</button>`;
        if (o.status === 'ready') actions = `<button class="btn btn-primary btn-sm me-2" data-action="orderStatus" data-id="${id}" data-status="completed">${o.fulfilment === 'pickup' ? 'Handed to customer' : 'Handed to rider'}</button>`;
        if (o.status === 'accepted' || o.status === 'preparing') actions += `<button class="btn btn-outline-danger btn-sm" data-action="orderReject" data-id="${id}" data-mode="cancelled">Cancel</button>`;

        let contact;
        if (o.status === 'pending') contact = '<div class="small text-muted"><i class="fas fa-lock me-1"></i>The customer\'s phone number and street are shown after you accept.</div>';
        else contact = `<div class="small"><i class="fas fa-phone me-1"></i>${o.customerPhone ? `<a href="tel:${esc(o.customerPhone)}">${esc(o.customerPhone)}</a>` : ''}${o.fulfilment === 'delivery' && o.dropoff ? ` &nbsp; <i class="fas fa-location-dot me-1"></i>${esc([o.dropoff.street, o.dropoff.area, o.dropoff.city].filter(Boolean).join(', '))}${o.dropoff.instructions ? ` <em>(${esc(o.dropoff.instructions)})</em>` : ''}` : ''}</div>`;

        let courier = '';
        if (o.fulfilment === 'delivery' && live) {
            courier = courierHtml(o.courier);
            if (o.courier.arrangedBy === 'chef') courier += `<div class="mt-2"><button class="btn btn-sm btn-outline-primary" data-action="orderCourier" data-id="${id}"><i class="fas fa-motorcycle me-1"></i>${o.courier.service ? 'Edit' : 'Add'} rider details</button><span class="small text-muted ms-2">Book the rider in Bolt, Uber or another app, then note who is coming.</span></div>`;
            else if (!o.courier.service) courier += '<div class="info-box"><i class="fas fa-motorcycle me-1"></i>The customer books the rider and will add the details here.</div>';
        }
        const reason = o.statusReason && (o.status === 'rejected' || o.status === 'cancelled')
            ? `<div class="reason-box"><strong>${o.status === 'rejected' ? 'You declined' : 'Cancelled'}:</strong> ${esc(orderReasonLabel(o.statusReason.code))}${o.statusReason.note ? ` – "${esc(o.statusReason.note)}"` : ''}</div>` : '';
        const where = o.fulfilment === 'delivery' ? `Delivery to ${[o.dropoff && o.dropoff.area, o.dropoff && o.dropoff.city].filter(Boolean).join(', ')}` : 'Customer collects';
        return `<div class="order-card">
            <div class="d-flex justify-content-between flex-wrap gap-2">
                <div><span class="code">${esc(o.code)}</span> · <strong>${esc(o.customerName)}</strong>
                    <div class="small text-muted">${esc(new Date(o.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }))} · ${esc(where)}</div></div>
                <div class="text-end">${orderBadge(o.status)}<div class="mt-1"><strong>${esc(money(o.subtotal, c))}</strong></div></div>
            </div>
            <div class="mt-2">${itemsList(o)}</div>${o.notes ? `<div class="small"><strong>Customer note:</strong> ${esc(o.notes)}</div>` : ''}
            ${live && o.readyAt ? `<div class="small text-muted">Promised ready around ${esc(clock(o.readyAt, tz))}</div>` : ''}
            ${contact}${courier}${reason}<div class="mt-2">${actions}</div>
        </div>`;
    }).join('');
}

async function chefOrderStatus(id, status) {
    const r = await guard(() => api.orders.updateStatus(id, status));
    if (!r) return;
    notify(`Order marked as ${status}.`);
    refreshChefOrders();
}

function openAccept(id) {
    const o = state.chefOrders.find((x) => x._id === id);
    const longest = Math.max(0, ...o.items.map((i) => { const m = state.meals.find((x) => x._id === i.meal); return m ? m.prepMinutes : 0; }));
    const options = [15, 20, 30, 45, 60, 90, 120, 180];
    $('acceptOrderId').value = id;
    $('acceptCode').textContent = o.code;
    $('acceptMinutes').innerHTML = '';
    options.forEach((m) => addOption($('acceptMinutes'), String(m), m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} minutes`));
    $('acceptMinutes').value = String(options.find((m) => m >= longest) || 30);
    modal('acceptOrderModal').show();
}

formHandlers.acceptOrderForm = async () => {
    const r = await guard(() => api.orders.updateStatus($('acceptOrderId').value, 'accepted', { readyInMinutes: Number($('acceptMinutes').value) }));
    if (!r) return;
    hideModal('acceptOrderModal');
    notify('Order accepted. The customer has been emailed.');
    refreshChefOrders();
};

function openOrderReject(id, mode) {
    const o = state.chefOrders.find((x) => x._id === id);
    $('orRejectId').value = id;
    $('orRejectStatus').value = mode;
    $('orderRejectTitle').textContent = `${mode === 'rejected' ? 'Decline' : 'Cancel'} order ${o.code}`;
    $('orRejectSubmit').textContent = mode === 'rejected' ? 'Decline order' : 'Cancel order';
    $('orRejectReason').innerHTML = '';
    state.meta.orderReasons.forEach((r) => addOption($('orRejectReason'), r.code, r.label));
    $('orRejectNote').value = '';
    modal('orderRejectModal').show();
}

formHandlers.orderRejectForm = async () => {
    const mode = $('orRejectStatus').value;
    const r = await guard(() => api.orders.updateStatus($('orRejectId').value, mode, { reasonCode: $('orRejectReason').value, reason: $('orRejectNote').value.trim() }));
    if (!r) return;
    hideModal('orderRejectModal');
    notify(mode === 'rejected' ? 'Order declined. The customer was told why.' : 'Order cancelled. The customer was told why.');
    refreshChefOrders();
};

/* ---- kitchen settings and meals ---- */
function renderKitchenPanel() {
    const ks = state.kitchenSettings, chef = state.chef, c = getCountry(chef.serviceLocation.country);
    $('kitchenPanel').innerHTML = `<div id="kitchenStatus"></div>
        <form id="kitchenForm" class="card mb-4"><div class="card-body">
            <h5 class="card-title">Your kitchen</h5>
            <p class="text-muted small">Sell meals for delivery or pickup as an independent kitchen. Customers near you see your menu. Your address and phone stay private until you accept an order.</p>
            <div class="row g-2 mb-2">
                <div class="col-md-6"><label class="form-label small mb-1" for="kName">Kitchen name</label><input type="text" class="form-control" id="kName" maxlength="60" value="${esc(ks.name)}" placeholder="e.g. Baraka's Kitchen"></div>
                <div class="col-md-6"><label class="form-label small mb-1" for="kTagline">Tagline (optional)</label><input type="text" class="form-control" id="kTagline" maxlength="120" value="${esc(ks.tagline)}" placeholder="e.g. Home-style Kenyan, cooked to order"></div>
            </div>
            <div class="row g-2 mb-2">
                <div class="col-md-6"><label class="form-label small mb-1" for="kPhone">Kitchen phone (shown to the customer after you accept)</label><input type="tel" class="form-control" id="kPhone" value="${esc(ks.phone || c.dialCode + ' ')}" placeholder="${esc(c.dialCode)}712345678"></div>
                <div class="col-md-6"><label class="form-label small mb-1" for="kMin">Minimum order (${esc(c.currency)}, optional)</label><input type="number" class="form-control" id="kMin" min="0" step="any" value="${esc(ks.minOrder)}"></div>
            </div>
            <h6 class="mt-3">Pickup address <span class="text-muted small">(private)</span></h6>
            <div class="row g-2 mb-2">
                <div class="col-md-6"><label class="form-label small mb-1" for="kStreet">Street / building</label><input type="text" class="form-control" id="kStreet" maxlength="150" value="${esc(ks.pickupAddress.street)}"></div>
                <div class="col-md-6"><label class="form-label small mb-1" for="kCity">City / town</label><input type="text" class="form-control" id="kCity" maxlength="80" value="${esc(ks.pickupAddress.city)}"></div>
                <div class="col-md-6"><label class="form-label small mb-1" for="kRegion">${esc(c.regionLabel)} (optional)</label><input type="text" class="form-control" id="kRegion" maxlength="80" value="${esc(ks.pickupAddress.state)}"></div>
                <div class="col-md-6"><label class="form-label small mb-1" for="kPostal">${esc(c.postalLabel)} (optional)</label><input type="text" class="form-control" id="kPostal" maxlength="20" value="${esc(ks.pickupAddress.zipCode)}"></div>
            </div>
            <div class="mb-2"><label class="form-label small mb-1" for="kAreas">Neighbourhoods you deliver to (separate with commas)</label>
                <input type="text" class="form-control" id="kAreas" value="${esc((ks.deliveryAreas || []).join(', '))}" placeholder="e.g. Westlands, Kilimani, Lavington">
                <div class="form-text">Leave empty to deliver anywhere in ${esc(chef.serviceLocation.city)}.</div></div>
            <h6 class="mt-3">How customers receive their food</h6>
            <div class="form-check"><input class="form-check-input" type="checkbox" id="kPickup" ${ks.fulfilment.pickup ? 'checked' : ''}><label class="form-check-label" for="kPickup">Customers can collect from my kitchen</label></div>
            <div class="form-check"><input class="form-check-input" type="checkbox" id="kCourier" ${ks.fulfilment.courier ? 'checked' : ''}><label class="form-check-label" for="kCourier">A rider from a delivery app (Bolt, Uber, Glovo, Little...) collects the food</label></div>
            <div class="ms-4 mb-3 mt-1">
                <div class="form-check"><input class="form-check-input" type="radio" name="kArranged" id="kArrChef" value="chef" ${ks.courierArrangedBy === 'chef' ? 'checked' : ''}><label class="form-check-label" for="kArrChef">I book the rider</label></div>
                <div class="form-check"><input class="form-check-input" type="radio" name="kArranged" id="kArrCustomer" value="customer" ${ks.courierArrangedBy === 'customer' ? 'checked' : ''}><label class="form-check-label" for="kArrCustomer">The customer books their own rider</label></div>
            </div>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="kEnabled" ${ks.enabled ? 'checked' : ''}><label class="form-check-label" for="kEnabled"><strong>List my kitchen on MyMealChef</strong></label></div>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="kOpen" ${ks.acceptingOrders ? 'checked' : ''}><label class="form-check-label" for="kOpen">Open for orders now</label></div>
            <div id="kitchenChecklist" class="small mt-3"></div>
            <button type="submit" class="btn btn-primary mt-3">Save kitchen settings</button>
        </div></form>
        <div class="card"><div class="card-body">
            <div class="d-flex justify-content-between align-items-center mb-2"><h5 class="card-title mb-0">Your meals</h5><button class="btn btn-primary btn-sm" data-action="addMeal"><i class="fas fa-plus me-1"></i>Add a meal</button></div>
            <p class="text-muted small">Log every dish you can cook for delivery. Switch a dish off when it is sold out.</p>
            <div id="mealsList"></div>
        </div></div>`;
    renderMealsList();
    renderKitchenStatus();
}

function renderKitchenStatus() {
    const ks = state.kitchenSettings;
    const tick = (ok, text) => `<div>${ok ? '<i class="fas fa-circle-check text-success me-1"></i>' : '<i class="far fa-circle text-muted me-1"></i>'}${esc(text)}</div>`;
    const available = state.meals.filter((m) => m.isAvailable).length;
    const list = $('kitchenChecklist');
    if (list) list.innerHTML = '<strong>To list your kitchen you need:</strong>' + tick(ks.isVerified, 'An approved chef profile') + tick(available > 0, 'At least one available meal') + tick(!!ks.name, 'A kitchen name (saved)') + tick(!!ks.phone, 'A phone number (saved)') + tick(!!(ks.pickupAddress.street && ks.pickupAddress.city), 'A pickup address (saved)');
    let html;
    if (!ks.isVerified) html = '<div class="alert alert-warning">Your chef profile must be approved before you can open a kitchen.</div>';
    else if (ks.enabled) html = `<div class="alert ${ks.acceptingOrders ? 'alert-success' : 'alert-secondary'} d-flex justify-content-between align-items-center flex-wrap gap-2"><span><i class="fas fa-store me-1"></i>Your kitchen is <strong>listed</strong> and <strong>${ks.acceptingOrders ? 'open' : 'closed'}</strong> for orders.</span><button class="btn btn-sm btn-light" data-action="toggleKitchenOpen">${ks.acceptingOrders ? 'Close for now' : 'Open for orders'}</button></div>`;
    else html = '<div class="alert alert-light border">Your kitchen is not listed yet. Add meals, fill in the form below and switch on "List my kitchen on MyMealChef".</div>';
    $('kitchenStatus').innerHTML = html;
}

function renderMealsList() {
    const c = getCountry(state.chef.serviceLocation.country);
    const box = $('mealsList');
    if (!state.meals.length) { box.innerHTML = '<div class="text-muted">No meals yet. Add your first one.</div>'; renderKitchenStatus(); return; }
    box.innerHTML = state.meals.map((m) => `<div class="meal-row">
        <div class="d-flex gap-3">${mealPhotoHtml(m)}<div><strong>${esc(m.name)}</strong> <span class="text-muted small">· ${esc(metaLabel(state.meta.categories, m.category))} · ${esc(m.cuisine)}${m.portion ? ` · ${esc(m.portion)}` : ''}</span>
            ${m.description ? `<div class="small text-muted">${esc(m.description)}</div>` : ''}
            <div class="mt-1">${(m.dietary || []).map((d) => `<span class="chip">${esc(metaLabel(state.meta.dietary, d))}</span>`).join('')}<span class="chip warn">~${esc(m.prepMinutes)} min</span>${m.isAvailable ? '' : '<span class="chip warn">Sold out</span>'}</div></div></div>
        <div class="text-end text-nowrap"><div class="mb-2"><strong>${esc(money(m.price, c))}</strong></div>
            <button class="btn btn-sm ${m.isAvailable ? 'btn-outline-secondary' : 'btn-outline-success'}" data-action="toggleMeal" data-id="${esc(m._id)}">${m.isAvailable ? 'Mark sold out' : 'Back in stock'}</button>
            <button class="btn btn-sm btn-outline-primary" data-action="editMeal" data-id="${esc(m._id)}"><i class="fas fa-pen"></i></button>
            <button class="btn btn-sm btn-outline-danger" data-action="deleteMeal" data-id="${esc(m._id)}"><i class="fas fa-trash"></i></button></div>
    </div>`).join('');
    renderKitchenStatus();
}

formHandlers.kitchenForm = async () => {
    const v = (id) => $(id).value.trim();
    const payload = {
        name: v('kName'), tagline: v('kTagline'), phone: v('kPhone').replace(/^\+\d+\s*$/, ''), minOrder: Number(v('kMin') || 0),
        pickupAddress: { street: v('kStreet'), city: v('kCity'), state: v('kRegion'), zipCode: v('kPostal') },
        deliveryAreas: v('kAreas').split(',').map((s) => s.trim()).filter(Boolean),
        fulfilment: { pickup: $('kPickup').checked, courier: $('kCourier').checked },
        courierArrangedBy: $('kArrCustomer').checked ? 'customer' : 'chef',
        enabled: $('kEnabled').checked, acceptingOrders: $('kOpen').checked
    };
    const r = await guard(() => api.kitchens.updateMine(payload));
    if (!r) return;
    state.kitchenSettings = r.data;
    notify(r.data.enabled ? 'Kitchen saved. Customers near you can now order from it.' : 'Kitchen settings saved.');
    renderKitchenPanel();
};

async function toggleKitchenOpen() {
    const r = await guard(() => api.kitchens.updateMine({ acceptingOrders: !state.kitchenSettings.acceptingOrders }));
    if (!r) return;
    state.kitchenSettings = r.data;
    notify(r.data.acceptingOrders ? 'Your kitchen is open for orders.' : 'Your kitchen is closed for now.', 'info');
    renderKitchenPanel();
}

function openMeal(id) {
    const m = id ? state.meals.find((x) => x._id === id) : null;
    const c = getCountry(state.chef.serviceLocation.country);
    $('mealTitle').textContent = m ? 'Edit meal' : 'Add a meal';
    $('mealPriceLabel').textContent = `Price (${c.currency})`;
    $('mealCategory').innerHTML = ''; state.meta.categories.forEach((x) => addOption($('mealCategory'), x.code, x.label));
    $('mealCuisine').innerHTML = ''; state.meta.cuisines.forEach((x) => addOption($('mealCuisine'), x, x));
    $('mealDietary').innerHTML = state.meta.dietary.map((d) => `<div class="form-check"><input class="form-check-input meal-diet" type="checkbox" value="${esc(d.code)}" id="md_${esc(d.code)}"><label class="form-check-label small" for="md_${esc(d.code)}">${esc(d.label)}</label></div>`).join('');
    $('mealId').value = m ? m._id : '';
    $('mealName').value = m ? m.name : '';
    $('mealPrice').value = m ? m.price : '';
    $('mealDesc').value = m ? m.description : '';
    $('mealCategory').value = m ? m.category : 'main';
    $('mealCuisine').value = m ? m.cuisine : state.chef.cuisineSpecialization;
    $('mealPortion').value = m ? m.portion : '';
    $('mealPrep').value = m ? m.prepMinutes : 30;
    $('mealAvailable').checked = m ? m.isAvailable : true;
    (m ? m.dietary : []).forEach((d) => { const el = $(`md_${d}`); if (el) el.checked = true; });
    const preview = $('mealPhotoPreview');
    if (m && m.thumb) { preview.src = imgSrc(m.thumb); preview.style.display = 'block'; $('mealPhotoRemoveWrap').style.display = 'block'; }
    else { preview.removeAttribute('src'); preview.style.display = 'none'; $('mealPhotoRemoveWrap').style.display = 'none'; }
    $('mealPhoto').value = '';
    $('mealPhotoRemove').checked = false;
    modal('mealModal').show();
}

async function reloadMeals() {
    const [m, ks] = await Promise.all([api.meals.list(), api.kitchens.mine()]);
    state.meals = m.data;
    state.kitchenSettings = ks.data;
    renderMealsList();
}

// Phone photos can be large; resize them in the browser to save upload time and mobile data.
async function shrinkImage(file, maxSide = 1600) {
    try {
        if (!window.createImageBitmap) return file;
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return file;
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        return blob ? new File([blob], 'meal.jpg', { type: 'image/jpeg' }) : file;
    } catch (e) { return file; }
}

formHandlers.mealForm = async () => {
    const id = $('mealId').value;
    const file = $('mealPhoto').files[0];
    if (file && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { notify('Choose a JPG, PNG or WebP photo.', 'warning'); return; }
    const data = {
        name: $('mealName').value.trim(), price: Number($('mealPrice').value), description: $('mealDesc').value.trim(),
        category: $('mealCategory').value, cuisine: $('mealCuisine').value, portion: $('mealPortion').value.trim(),
        prepMinutes: Number($('mealPrep').value), isAvailable: $('mealAvailable').checked,
        dietary: [...document.querySelectorAll('.meal-diet')].filter((x) => x.checked).map((x) => x.value)
    };
    const r = await guard(() => (id ? api.meals.update(id, data) : api.meals.create(data)));
    if (!r) return;
    const mealId = id || r.data._id;
    let note = '';
    if (file) {
        const small = await shrinkImage(file);
        if (small.size > 10 * 1024 * 1024) note = ' The photo is too large, so it was not saved: choose a smaller one.';
        else {
            const form = new FormData();
            form.append('photo', small, small.name || 'meal.jpg');
            const up = await guard(() => api.meals.uploadPhoto(mealId, form));
            if (!up) note = ' The photo could not be saved: edit the meal to try again.';
        }
    } else if (id && $('mealPhotoRemove').checked) {
        await guard(() => api.meals.removePhoto(id));
    }
    hideModal('mealModal');
    notify((id ? 'Meal updated.' : 'Meal added to your menu.') + note, note ? 'warning' : 'success');
    await guard(reloadMeals, { quiet: true });
};

async function toggleMeal(id) {
    const m = state.meals.find((x) => x._id === id);
    const r = await guard(() => api.meals.update(id, { isAvailable: !m.isAvailable }));
    if (!r) return;
    await guard(reloadMeals, { quiet: true });
}

async function removeMeal(id) {
    const m = state.meals.find((x) => x._id === id);
    if (!confirm(`Delete "${m.name}" from your menu?`)) return;
    const r = await guard(() => api.meals.remove(id));
    if (!r) return;
    notify('Meal deleted.', 'info');
    await guard(reloadMeals, { quiet: true });
}

/* ----------------- discovery feed, saved items and chef stories ----------------- */
const splitTags = (value) => [...new Set(String(value || '').split(',').map((x) => x.trim()).filter(Boolean))];
const chefName = (chef) => `${chef?.user?.firstName || 'Chef'} ${chef?.user?.lastName || ''}`.trim();
const chefLocation = (chef) => [chef?.serviceLocation?.city, chef?.serviceLocation?.state, getCountry(chef?.serviceLocation?.country).name].filter(Boolean).join(', ');

async function loadDiscoveryOptions() {
    const select = $('discoveryChef');
    if (!select || select.dataset.loaded === 'true') return;
    try {
        const r = await api.chefs.getAll({ country: getCountry().code });
        select.innerHTML = '<option value="">All chefs</option>' + r.data.map((c) => `<option value="${esc(c._id)}">${esc(chefName(c))}</option>`).join('');
        select.dataset.loaded = 'true';
    } catch (e) { /* feed remains usable without the optional chef filter */ }
}

function discoveryParams() {
    return { cuisine: $('discoveryCuisine').value, chef: $('discoveryChef').value, dish: $('discoveryDish').value.trim(), location: $('discoveryLocation').value.trim(), country: getCountry().code, dietary: $('discoveryDietary').value, occasion: $('discoveryOccasion').value };
}

function postMarkup(post) {
    const chef = post.chef || {}, chefId = chef._id;
    const mediaUrl = (m) => String(m?.secureUrl || '').replace(`/${m?.resourceType || (post.kind === 'video' ? 'video' : 'image')}/upload/`, `/${m?.resourceType || (post.kind === 'video' ? 'video' : 'image')}/upload/${post.kind === 'video' ? 'q_auto' : 'f_auto,q_auto'}/`);
    const media = post.kind === 'video'
        ? `<video class="story-media" muted playsinline loop controls preload="none" data-video-src="${esc(mediaUrl(post.media[0]))}" aria-label="${esc(post.dishName)} cooking video"></video>`
        : `<div class="story-carousel">${post.media.map((m) => `<img src="${esc(mediaUrl(m))}" alt="${esc(post.dishName)} by ${esc(chefName(chef))}" loading="lazy">`).join('')}</div>`;
    return `<article class="story-card" data-post-id="${esc(post._id)}"><div class="story-visual">${media}<div class="story-visual-shade"></div><div class="story-chef"><img src="${esc(chef.profileImage || '')}" alt="" loading="lazy" onerror="this.style.display='none'"><div><strong>${esc(chefName(chef))}</strong><small>${esc((post.cuisines || []).join(' · '))} · ${esc(chefLocation(chef))}</small></div><button class="story-icon" data-action="openChefProfile" data-id="${esc(chefId)}" aria-label="View chef profile"><i class="fas fa-arrow-up-right-from-square"></i></button></div><div class="story-copy"><span class="eyebrow">Cooked in your home</span><h3>${esc(post.dishName)}</h3><p>${esc(post.caption || 'A signature dish, prepared fresh at your table.')}</p><strong>${esc(money(chef.hourlyRate, getCountry(chef.serviceLocation?.country)))} <small>/ hour</small></strong></div></div><div class="story-actions"><button class="btn btn-light btn-sm ${post.likedByMe ? 'is-active' : ''}" data-action="toggleInteraction" data-kind="like" data-type="post" data-id="${esc(post._id)}"><i class="${post.likedByMe ? 'fas' : 'far'} fa-heart"></i> <span>${post.likedByMe ? 'Liked' : 'Like'}</span> <b>${esc(post.likeCount || 0)}</b></button><button class="btn btn-light btn-sm ${post.savedByMe ? 'is-active' : ''}" data-action="toggleInteraction" data-kind="save" data-type="post" data-id="${esc(post._id)}"><i class="${post.savedByMe ? 'fas' : 'far'} fa-bookmark"></i> <span>${post.savedByMe ? 'Saved' : 'Save'}</span></button><button class="btn btn-outline-primary btn-sm" data-action="sharePost" data-id="${esc(post._id)}"><i class="fas fa-share-nodes"></i> Share</button><button class="btn btn-primary btn-sm ms-auto" data-action="bookChef" data-id="${esc(chefId)}">Book this chef</button></div><div class="story-tags">${[...(post.dietaryTags || []), ...(post.occasions || [])].map((x) => `<span class="chip">${esc(x.replaceAll('_', ' '))}</span>`).join('')}</div></article>`;
}

function observeStoryVideos(root) {
    if (state.discoveryObserver) state.discoveryObserver.disconnect();
    const videos = [...root.querySelectorAll('video[data-video-src]')];
    const load = (video, visible) => {
        if (!video.src && video.dataset.videoSrc) video.src = video.dataset.videoSrc;
        if (visible) video.play().catch(() => {}); else video.pause();
    };
    if (!('IntersectionObserver' in window)) { videos.forEach((video) => load(video, false)); return; }
    state.discoveryObserver = new IntersectionObserver((entries) => entries.forEach((entry) => load(entry.target, entry.isIntersecting)), { threshold: 0.55 });
    videos.forEach((video) => state.discoveryObserver.observe(video));
}

async function loadDiscoveryFeed(params = discoveryParams(), targetId = '') {
    const root = $('discoveryFeed');
    if (!root) return;
    root.innerHTML = '<div class="chef-loading">Finding chefs and their latest dishes…</div>';
    const r = await guard(() => api.discovery.posts(targetId ? { post: targetId } : params));
    if (!r) { root.innerHTML = '<div class="alert alert-light border">Stories could not be loaded. Please try again.</div>'; return; }
    if (!r.data.length) { root.innerHTML = '<div class="discovery-empty"><i class="fas fa-utensils"></i><h3>No cooking stories yet</h3><p>Try a different cuisine or location. New chef stories will appear here.</p></div>'; return; }
    root.innerHTML = r.data.map(postMarkup).join('');
    observeStoryVideos(root);
    if (targetId) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function hydrateInteractions(targetType, ids) {
    if (!ids.length) return;
    try {
        const r = await api.interactions.summary(targetType, ids);
        for (const summary of r.data) {
            document.querySelectorAll(`[data-type="${targetType}"][data-id="${summary.id}"]`).forEach((button) => paintInteraction(button, summary));
        }
    } catch (e) { /* buttons remain in the unauthenticated default state */ }
}

function paintInteraction(button, item) {
    const active = item.active ?? item[button.dataset.kind === 'like' ? 'liked' : 'saved'];
    button.classList.toggle('is-active', !!active);
    const icon = button.querySelector('i');
    const kind = item.kind || button.dataset.kind;
    if (icon) icon.className = kind === 'like' ? `${active ? 'fas' : 'far'} fa-heart` : `${active ? 'fas' : 'far'} fa-bookmark`;
    const label = button.querySelector('span');
    if (label) label.textContent = kind === 'like' ? (active ? 'Liked' : 'Like') : (active ? 'Saved' : 'Save');
    const count = button.querySelector('b'); if (count && item.likeCount !== undefined) count.textContent = item.likeCount;
}

async function toggleInteraction(data) {
    if (!state.user) { state.returnTo = document.querySelector('.page[style*="display: block"]')?.id || 'discoveryPage'; notify('Log in to save favourites and like dishes.'); showPage('customerAuthPage'); return; }
    if (state.user.role !== 'customer') { notify('Favourites are available on customer accounts.', 'info'); return; }
    const button = document.querySelector(`[data-action="toggleInteraction"][data-id="${data.id}"][data-kind="${data.kind}"]`);
    if (!button) return;
    button.disabled = true;
    const r = await guard(() => api.interactions.toggle({ kind: data.kind, targetType: data.type, target: data.id }), { quiet: true });
    button.disabled = false;
    if (!r) return;
    paintInteraction(button, { kind: data.kind, active: r.active, likeCount: r.likeCount });
    notify(r.active ? (data.kind === 'like' ? 'Added to your likes.' : 'Saved for later.') : (data.kind === 'like' ? 'Like removed.' : 'Removed from saved items.'), 'success');
    if (data.kind === 'save' && $('myBookingsPage').style.display === 'block') loadSavedItems();
}

async function loadSavedItems() {
    if (!requireRole('customer')) return;
    $('savedChefsList').innerHTML = '<div class="text-muted py-3">Loading your saved chefs…</div>';
    $('savedDishesList').innerHTML = '<div class="text-muted py-3">Loading your saved dishes…</div>';
    const r = await guard(() => api.interactions.saved(), { quiet: true });
    if (!r) return;
    const chefs = (r.data.chefs || []).map((x) => x.item), dishes = r.data.dishes || [];
    $('savedChefsList').innerHTML = chefs.length ? `<div class="saved-grid">${chefs.map((chef) => `<article class="saved-card"><img src="${esc(chef.profileImage || '')}" alt="" loading="lazy"><div><h3>${esc(chefName(chef))}</h3><p>${esc([chef.cuisineSpecialization, ...(chef.additionalCuisines || [])].join(' · '))} · ${esc(chefLocation(chef))}</p><button class="btn btn-sm btn-primary" data-action="bookChef" data-id="${esc(chef._id)}">Book chef</button> <button class="btn btn-sm btn-outline-secondary" data-action="toggleInteraction" data-kind="save" data-type="chef" data-id="${esc(chef._id)}">Remove</button></div></article>`).join('')}</div>` : '<div class="discovery-empty"><h3>No saved chefs yet</h3><p>Save a chef profile and it will be ready here when you plan your next meal.</p><button class="btn btn-outline-primary" data-action="goPage" data-page="discoveryPage">Explore chefs</button></div>';
    $('savedDishesList').innerHTML = dishes.length ? `<div class="saved-grid">${dishes.map((saved) => {
        const item = saved.item, isPost = saved.type === 'post'; const chef = item.chef; const title = isPost ? item.dishName : item.name; const photo = isPost ? item.media?.[0]?.secureUrl : item.photoVersion ? imgSrc(`/api/photos/meals/${item._id}?v=${item.photoVersion}&size=thumb`) : '';
        return `<article class="saved-card"><img src="${esc(photo || '')}" alt="${esc(title)}" loading="lazy"><div><h3>${esc(title)}</h3><p>${esc(chefName(chef))} · ${esc(chefLocation(chef))}</p><button class="btn btn-sm btn-primary" data-action="openChefProfile" data-id="${esc(chef?._id)}">View chef</button> <button class="btn btn-sm btn-outline-secondary" data-action="toggleInteraction" data-kind="save" data-type="${esc(saved.type)}" data-id="${esc(item._id)}">Remove</button></div></article>`;
    }).join('')}</div>` : '<div class="discovery-empty"><h3>No saved dishes yet</h3><p>Save a dish from a cooking story or chef menu to collect ideas for your next booking.</p><button class="btn btn-outline-primary" data-action="goPage" data-page="discoveryPage">Explore dishes</button></div>';
}

async function openChefProfile(id) {
    if (!id) return;
    state.profileChefId = id; showPage('chefProfilePage');
    $('chefProfileContent').innerHTML = '<div class="chef-loading">Opening chef profile…</div>';
    const r = await guard(() => api.chefs.getById(id));
    if (!r) return;
    const chef = r.data; state.currentProfileChef = chef;
    if (!state.chefs.some((c) => c._id === id)) state.chefs.push(chef);
    const stories = await api.discovery.posts({ chef: id, limit: 24 }).catch(() => ({ data: [] }));
    const dishes = chef.signatureDishes || [];
    $('chefProfileContent').innerHTML = `<section class="chef-profile-hero"><img src="${esc(chef.profileImage || '')}" alt="${esc(chefName(chef))}" loading="lazy"><div><span class="eyebrow">Your chef, at your table</span><h1>${esc(chefName(chef))}</h1><p>${esc(chefLocation(chef))} · ${esc(chef.experience)} years experience</p><p>${esc([chef.cuisineSpecialization, ...(chef.additionalCuisines || [])].join(' · '))}</p><p>${esc(chef.bio || '')}</p><div>${stars(chef.rating?.average)} ${esc(chef.rating?.count || 0)} reviews</div><h3 class="mt-3">${esc(money(chef.hourlyRate, getCountry(chef.serviceLocation?.country)))} <small>/ hour</small></h3><button class="btn btn-primary" data-action="bookChef" data-id="${esc(id)}">Check availability & book</button> <button class="btn btn-outline-primary" data-action="toggleInteraction" data-kind="like" data-type="chef" data-id="${esc(id)}"><i class="far fa-heart"></i> <span>Like</span><b class="ms-1">0</b></button> <button class="btn btn-outline-primary" data-action="toggleInteraction" data-kind="save" data-type="chef" data-id="${esc(id)}"><i class="far fa-bookmark"></i> <span>Save chef</span></button></div></section><div class="my-4"><h2>Signature dishes</h2><div class="story-tags">${dishes.length ? dishes.map((dish) => `<span class="chip">${esc(dish)}</span>`).join('') : '<span class="text-muted">Ask for a menu tailored to your occasion.</span>'}</div><h3 class="h5 mt-3">Photo collections & cooking videos</h3><p class="text-muted">Browse this chef’s cooking stories below.</p></div><h2>Cooking stories</h2><div class="discovery-feed">${stories.data.length ? stories.data.map(postMarkup).join('') : '<div class="text-muted py-3">This chef has not shared a cooking story yet.</div>'}</div>`;
    observeStoryVideos($('chefProfileContent'));
    hydrateInteractions('chef', [id]);
}

async function loadChefStories() {
    if (state.user?.role !== 'chef') return;
    const box = $('chefStoriesPanel'); if (!box) return;
    try {
        const r = await api.discovery.myPosts();
        state.chefPosts = r.data;
        box.innerHTML = `<div class="d-flex justify-content-between align-items-center mb-3"><div><h4>Stories from your kitchen</h4><p class="text-muted mb-0">Short cooking videos and photo collections help customers find you.</p></div><button class="btn btn-primary" data-action="newStory"><i class="fas fa-plus me-1"></i>New story</button></div>${r.data.length ? `<div class="chef-story-list">${r.data.map((p) => `<div class="chef-story-row"><strong>${esc(p.dishName)}</strong><span>${esc(p.kind)} · ${(p.media || []).length} item(s)</span><button class="btn btn-sm btn-outline-primary" data-action="editStory" data-id="${esc(p._id)}">Edit</button><button class="btn btn-sm btn-outline-danger" data-action="deleteStory" data-id="${esc(p._id)}">Delete</button></div>`).join('')}</div>` : '<div class="discovery-empty"><p>You have not shared a cooking story yet. Post a short video or a collection of dish photos.</p></div>'}`;
    } catch (e) { box.innerHTML = '<div class="alert alert-light border">Your stories could not be loaded. Please try again later.</div>'; }
}

function editStory(id) {
    const post = (state.chefPosts || []).find((p) => p._id === id);
    if (!post) { notify('Reload your stories and try again.', 'warning'); return; }
    openStoryEditor(post);
}

async function deleteStory(id) {
    if (!confirm('Delete this cooking story and its uploaded media?')) return;
    const r = await guard(() => api.discovery.deletePost(id));
    if (r) { notify('Cooking story deleted.'); loadChefStories(); }
}

async function sharePost(id) {
    const url = new URL(location.href); url.hash = `post=${id}`;
    try { await navigator.clipboard.writeText(url.toString()); notify('Story link copied.'); }
    catch (e) { prompt('Copy this story link:', url.toString()); }
}

function openStoryEditor(post) {
    $('storyForm').reset(); $('storyPostId').value = post?._id || '';
    $('storyModalTitle').textContent = post ? 'Edit cooking story' : 'Share a cooking story';
    $('storySubmitBtn').textContent = post ? 'Save changes' : 'Publish story';
    $('storyDishName').value = post?.dishName || ''; $('storyCaption').value = post?.caption || '';
    $('storyCuisines').value = (post?.cuisines || [state.chef?.cuisineSpecialization]).filter(Boolean).join(', ');
    $('storyOccasions').value = (post?.occasions || []).join(', '); $('storyDietary').value = (post?.dietaryTags || []).join(', ');
    $('storyKind').value = post?.kind || 'video'; $('storyKind').disabled = !!post; $('storyMediaFiles').required = !post; $('storyMediaFiles').disabled = !!post;
    setStoryMediaInput(); $('storyUploadStatus').textContent = post ? 'To replace media, delete this story and create a new one.' : '';
    modal('storyEditorModal').show();
}

function setStoryMediaInput() {
    const video = $('storyKind').value === 'video'; $('storyMediaFiles').accept = video ? 'video/mp4,video/webm,video/quicktime' : 'image/jpeg,image/png,image/webp';
    $('storyMediaFiles').multiple = !video;
    $('storyMediaHint').textContent = video ? 'MP4, WebM or MOV, up to 50 MB and 30 seconds.' : 'JPG, PNG or WebP, up to 10 MB each; choose up to 6 photos.';
}

async function fileDuration(file) {
    return new Promise((resolve, reject) => { const video = document.createElement('video'), url = URL.createObjectURL(file); video.preload = 'metadata'; video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(video.duration); }; video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read video duration.')); }; video.src = url; });
}

async function uploadStoryFiles(files) {
    const video = $('storyKind').value === 'video';
    if (!files.length || files.length > (video ? 1 : 6)) throw new Error(video ? 'Choose one video.' : 'Choose up to six photos.');
    for (const file of files) {
        if (file.size > (video ? 50 : 10) * 1024 * 1024) throw new Error(video ? 'Videos must be 50 MB or smaller.' : 'Each photo must be 10 MB or smaller.');
        if (video && (!file.type.startsWith('video/') || await fileDuration(file) > 30)) throw new Error('Choose a supported video up to 30 seconds long.');
        if (!video && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Photos must be JPG, PNG, or WebP.');
    }
    const sig = (await api.discovery.uploadSignature()).data;
    const uploaded = [];
    for (let i = 0; i < files.length; i++) {
        $('storyUploadStatus').textContent = `Uploading ${i + 1} of ${files.length}…`;
        const form = new FormData(); form.append('file', files[i]); form.append('api_key', sig.apiKey); form.append('timestamp', sig.timestamp); form.append('signature', sig.signature); form.append('public_id', sig.publicId);
        if (sig.uploadPreset) form.append('upload_preset', sig.uploadPreset);
        const type = video ? 'video' : 'image';
        const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(sig.cloudName)}/${type}/upload`, { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || 'Media upload failed.');
        uploaded.push({ publicId: result.public_id, resourceType: result.resource_type });
    }
    return uploaded;
}

formHandlers.discoveryFilters = async (form) => { await loadDiscoveryFeed(discoveryParams()); };
formHandlers.storyForm = async () => {
    if (!state.user || state.user.role !== 'chef' || !(await ensureVerified())) return;
    const id = $('storyPostId').value;
    const data = { dishName: $('storyDishName').value.trim(), caption: $('storyCaption').value.trim(), cuisines: splitTags($('storyCuisines').value), occasions: splitTags($('storyOccasions').value), dietaryTags: splitTags($('storyDietary').value) };
    $('storySubmitBtn').disabled = true;
    try {
        if (id) await api.discovery.updatePost(id, data);
        else { data.kind = $('storyKind').value; data.media = await uploadStoryFiles([...$('storyMediaFiles').files]); await api.discovery.createPost(data); }
        hideModal('storyEditorModal'); notify(id ? 'Cooking story updated.' : 'Cooking story published.'); await loadChefStories();
    } catch (e) { notify(e.message || 'Could not publish this story.', 'danger'); }
    finally { $('storySubmitBtn').disabled = false; $('storyUploadStatus').textContent = ''; }
};

/* ------------------------- clicks, forms and changes ------------------------- */
const actions = {
    logout, goPage: (d) => showPage(d.page), bookChef: (d) => startBooking(d.id),
    homeSearchMode: (d) => setHomeSearchMode(d.mode),
    calPrev: () => changeMonth(-1), calNext: () => changeMonth(1),
    pickDate: (d) => pickDate(d.date), pickSlot: (d) => pickSlot(d.time), confirmBooking,
    openReview: (d) => openReview(d.id),
    chefStatus: (d) => chefSetStatus(d.id, d.status), chefReject: (d) => openReject(d.id, d.mode),
    deleteTimeOff: (d) => removeTimeOff(d.id),
    chefCalPrev: () => chefCalMove(-1), chefCalNext: () => chefCalMove(1),
    chefCalPick: (d) => { $('toStart').value = d.date; $('toEnd').value = d.date; $('toStart').scrollIntoView({ behavior: 'smooth', block: 'center' }); },
    reapply: () => { $('reapplyBox').innerHTML = applicationFormHtml(); },
    refreshAdmin: loadAdminPage, forgotPassword: openForgot, resendVerification,
    openKitchen: (d) => openKitchen(d.id), cartAdd: (d) => cartChange(d.id, 1), cartSub: (d) => cartChange(d.id, -1), checkout: startCheckout,
    refreshMyOrders: loadMyOrders, cancelOrder: (d) => cancelMyOrder(d.id), copyText: (d) => copyText(d.text),
    orderCourier: (d) => openCourier((state.user.role === 'chef' ? state.chefOrders : state.myOrders).find((o) => o._id === d.id)),
    refreshChefOrders, orderAccept: (d) => openAccept(d.id), orderReject: (d) => openOrderReject(d.id, d.mode), orderStatus: (d) => chefOrderStatus(d.id, d.status),
    viewPhoto: (d) => { $('photoModalImg').src = d.src; $('photoModalImg').alt = d.caption; $('photoModalCaption').textContent = d.caption; modal('photoModal').show(); },
    addMeal: () => openMeal(), editMeal: (d) => openMeal(d.id), toggleMeal: (d) => toggleMeal(d.id), deleteMeal: (d) => removeMeal(d.id), toggleKitchenOpen,
    adminDoc: (d) => openAdminDoc(d.id, d.type), adminSchedule: (d) => openSchedule(d.id),
    adminInterviewDone: (d) => openInterviewDone(d.id), adminApprove: (d) => approveChef(d.id),
    adminReject: (d) => { $('arChefId').value = d.id; $('arReason').value = ''; modal('adminRejectModal').show(); },
    toggleInteraction: (d) => toggleInteraction(d), openChefProfile: (d) => openChefProfile(d.id), sharePost: (d) => sharePost(d.id),
    newStory: () => openStoryEditor(), editStory: (d) => editStory(d.id), deleteStory: (d) => deleteStory(d.id)
};

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn(el.dataset, el);
});

document.addEventListener('submit', async (e) => {
    const handler = formHandlers[e.target.id];
    if (!handler) return;
    e.preventDefault();
    await handler(e.target);
});

document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('js-country-select')) setCountry(t.value);
    else if (t.id === 'signupCountry') updateSignupCountryUI();
    else if (t.id === 'bookingDuration') { if (state.booking && state.booking.date) loadSlots(); else updateBookingSummary(); }
    else if (t.name === 'coFulfilment') updateCheckoutView();
    else if (t.id === 'toAllDay') $('toTimes').style.display = t.checked ? 'none' : 'flex';
    else if (t.name === 'ivPassed') $('ivReasonBox').style.display = $('ivPassedNo').checked ? 'block' : 'none';
    else if (t.id === 'storyKind') setStoryMediaInput();
});

/* --------------------------------- 9. start-up -------------------------------- */
function initCounters() {
    const nums = document.querySelectorAll('.stat-number');
    if (!nums.length) return;
    const run = (el) => {
        const target = Number(el.dataset.target) || 0;
        const start = performance.now();
        const tick = (now) => {
            const p = Math.min(1, (now - start) / 1500);
            el.textContent = Math.round(target * p).toLocaleString();
            if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };
    if (!('IntersectionObserver' in window)) { nums.forEach(run); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { run(en.target); io.unobserve(en.target); } }), { threshold: 0.4 });
    nums.forEach((n) => io.observe(n));
}

async function init() {
    initCounters();
    try {
        const r = await api.countries.getAll();
        state.countries = r.data;
        if (!state.countries.some((c) => c.code === state.countryCode)) state.countryCode = r.default || 'KE';
    } catch (e) { state.countries = [FALLBACK_COUNTRY]; state.countryCode = 'KE'; }
    renderCountrySelects();
    initGoogle(); // not awaited: the page must not wait for Google
    api.bookings.reasonCodes().then((r) => { state.reasonCodes = r.data; }).catch(() => {});
    state.resetToken = takeHashToken('reset');
    const verifyToken = state.resetToken ? null : takeHashToken('verify');
    const sharedPost = !state.resetToken && !verifyToken && /^#post=[a-f\d]{24}$/i.test(location.hash) ? location.hash.slice(6) : null;
    if (sharedPost) history.replaceState(null, '', `${location.pathname}${location.search}`);
    await restoreSession();
    renderNav();
    if (state.resetToken) { $('resetExpired').style.display = 'none'; showPage('resetPasswordPage'); }
    else if (verifyToken) await confirmEmail(verifyToken);
    else if (sharedPost) { state.openPostId = sharedPost; showPage('discoveryPage'); }
    else showPage('homePage');
}

init();
