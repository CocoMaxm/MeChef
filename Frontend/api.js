// ChefMtaani API client. Every backend endpoint the website uses lives here.
// When the page is served by the backend (or deployed), the API is on the same origin.
// Only when opened via VS Code Live Server (port 5500) or as a file does it call localhost:5000.
const API_BASE_URL =
  (location.protocol === 'file:' || ['5500', '5501'].includes(location.port))
    ? 'http://localhost:5000/api'
    : `${location.origin}/api`;

const getAuthToken = () => localStorage.getItem('authToken');

// Turns every response into either data or a readable Error
const handleResponse = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    console.error('Server returned non-JSON response:', text);
    throw new Error(`Server Error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!response.ok) {
    // An expired/invalid login: let the app sign the user out cleanly
    if (response.status === 401 && getAuthToken()) window.dispatchEvent(new Event('auth-expired'));
    const err = new Error(data.error || data.message || 'Something went wrong');
    err.status = response.status;
    err.code = data.code; // e.g. PASSWORD_REQUIRED
    throw err;
  }
  return data;
};

// request('GET', '/chefs', { auth: true, json: {...} }  or  { form: FormData })
const request = async (method, path, { json, form, auth = false } = {}) => {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${getAuthToken()}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // multipart: the browser sets the Content-Type (with boundary) itself
  return handleResponse(await fetch(`${API_BASE_URL}${path}`, { method, headers, body }));
};
const qs = (params = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

const api = {
  config: { get: () => request('GET', '/config') }, // public settings, e.g. the Google Client ID
  countries: { getAll: () => request('GET', '/countries') },

  auth: {
    register: (userData) => request('POST', '/auth/register', { json: userData }),
    login: (credentials) => request('POST', '/auth/login', { json: credentials }),
    registerChef: (chefData) => request('POST', '/auth/register-chef', { json: chefData }),
    // Google sign-in: credential comes from Google's button; password only when linking an existing account
    google: (credential, password) => request('POST', '/auth/google', { json: { credential, password } }),
    // Forgot password: the server emails a single-use link; the page it opens calls resetPassword
    // Email confirmation: the emailed link opens the site, which calls verifyEmail
    verifyEmail: (token) => request('POST', '/auth/verify-email', { json: { token } }),
    resendVerification: () => request('POST', '/auth/resend-verification', { auth: true }),
    forgotPassword: (email) => request('POST', '/auth/forgot-password', { json: { email } }),
    resetPassword: (token, password) => request('POST', '/auth/reset-password', { json: { token, password } }),
    me: () => request('GET', '/auth/me', { auth: true }),
    myApplication: () => request('GET', '/auth/my-application', { auth: true }),
    // formData: answers (JSON string), phone, preferredInterviewTimes, passportPhoto, certificate
    submitApplication: (formData) => request('POST', '/auth/submit-application', { auth: true, form: formData }),
  },

  chefs: {
    getAll: (params) => request('GET', `/chefs${qs(params)}`),
    getById: (id) => request('GET', `/chefs/${id}`),
    getMyProfile: () => request('GET', '/chefs/me', { auth: true }),
    update: (id, data) => request('PUT', `/chefs/${id}`, { auth: true, json: data }),
    getAvailability: (id, startDate, endDate) => request('GET', `/chefs/${id}/availability${qs({ startDate, endDate })}`),
    getSlots: (id, date, duration) => request('GET', `/chefs/${id}/slots${qs({ date, duration })}`),
    // time off: periods the chef is not available, set in advance
    getTimeOff: () => request('GET', '/chefs/me/time-off', { auth: true }),
    addTimeOff: (data) => request('POST', '/chefs/me/time-off', { auth: true, json: data }),
    deleteTimeOff: (id) => request('DELETE', `/chefs/me/time-off/${id}`, { auth: true }),
  },

  bookings: {
    create: (bookingData) => request('POST', '/bookings', { auth: true, json: bookingData }),
    getMy: () => request('GET', '/bookings', { auth: true }),
    reasonCodes: () => request('GET', '/bookings/reason-codes'),
    // status: confirmed | rejected | cancelled | completed.  extra: { reasonCode, reason } for rejected/cancelled
    updateStatus: (id, status, extra = {}) => request('PUT', `/bookings/${id}/status`, { auth: true, json: { status, ...extra } }),
    addReview: (id, reviewData) => request('POST', `/bookings/${id}/review`, { auth: true, json: reviewData }),
  },

  cuisines: { getAll: (params) => request('GET', `/cuisines${qs(params)}`) },

  discovery: {
    posts: (params = {}) => request('GET', `/discovery/posts${qs(params)}`),
    myPosts: () => request('GET', '/discovery/mine', { auth: true }),
    uploadSignature: () => request('POST', '/discovery/uploads/signature', { auth: true, json: {} }),
    createPost: (data) => request('POST', '/discovery/posts', { auth: true, json: data }),
    updatePost: (id, data) => request('PUT', `/discovery/posts/${id}`, { auth: true, json: data }),
    deletePost: (id) => request('DELETE', `/discovery/posts/${id}`, { auth: true }),
  },
  interactions: {
    summary: (targetType, targetIds) => request('GET', `/interactions/summary${qs({ targetType, targetIds: targetIds.join(',') })}`),
    saved: () => request('GET', '/interactions/saved', { auth: true }),
    toggle: (data) => request('POST', '/interactions/toggle', { auth: true, json: { ...data, targetId: data.targetId || data.target } }),
  },

  // Food ordering: chefs as independent kitchens
  kitchens: {
    meta: () => request('GET', '/kitchens/meta'),
    list: (params) => request('GET', `/kitchens${qs(params)}`),            // country, city, area, cuisine, dietary
    get: (chefId) => request('GET', `/kitchens/${chefId}`),
    mine: () => request('GET', '/kitchens/me', { auth: true }),
    updateMine: (data) => request('PUT', '/kitchens/me', { auth: true, json: data }),
  },
  meals: {
    list: () => request('GET', '/meals', { auth: true }),
    create: (data) => request('POST', '/meals', { auth: true, json: data }),
    update: (id, data) => request('PUT', `/meals/${id}`, { auth: true, json: data }),
    remove: (id) => request('DELETE', `/meals/${id}`, { auth: true }),
    uploadPhoto: (id, formData) => request('PUT', `/meals/${id}/photo`, { auth: true, form: formData }), // field name: photo
    removePhoto: (id) => request('DELETE', `/meals/${id}/photo`, { auth: true }),
  },
  orders: {
    create: (data) => request('POST', '/orders', { auth: true, json: data }),
    list: () => request('GET', '/orders', { auth: true }),
    // status: accepted (+readyInMinutes) | preparing | ready | completed | rejected / cancelled (+reasonCode, reason)
    updateStatus: (id, status, extra = {}) => request('PUT', `/orders/${id}/status`, { auth: true, json: { status, ...extra } }),
    setCourier: (id, data) => request('PUT', `/orders/${id}/courier`, { auth: true, json: data }), // service, riderName, riderPhone, trackingLink
  },

  contact: { submit: (contactData) => request('POST', '/contact', { json: contactData }) },

  admin: {
    pendingChefs: () => request('GET', '/admin/pending-chefs', { auth: true }),
    scheduleInterview: (id, scheduledAt, meetingLink) =>
      request('POST', `/admin/chefs/${id}/interview`, { auth: true, json: { scheduledAt, meetingLink } }),
    completeInterview: (id, passed, notes, reason) =>
      request('POST', `/admin/chefs/${id}/interview/complete`, { auth: true, json: { passed, notes, reason } }),
    verifyChef: (id, status, reason) => request('POST', `/admin/verify-chef/${id}`, { auth: true, json: { status, reason } }),
    // Documents need the login header, so they are fetched as a blob and opened from a local URL
    documentBlobUrl: async (id, type) => {
      const response = await fetch(`${API_BASE_URL}/admin/chefs/${id}/documents/${type}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (!response.ok) throw new Error('Could not load the document');
      return URL.createObjectURL(await response.blob());
    },
  },
};
