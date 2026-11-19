(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const cfg = window.CHINO_CONFIG || {};
  const intervalMs = Math.max(10, Number(cfg.refreshSeconds) || 15) * 1000;
  const names = { available: 'Disponible', full: 'Usada', reserved: 'Reservada' };
  const icons = { available: 'i-check', full: 'i-lock', reserved: 'i-clock' };
  const state = {
    client: null, user: null, role: null, inventory: [], owned: [], keys: [], approvals: [],
    filter: 'all', search: '', tab: 'stock', mode: 'login', loading: false,
    refreshQueued: false, claimBusy: new Set(), toastTimeout: 0, lastClaim: null
  };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const svg = (name) => `<svg class="icon" aria-hidden="true"><use href="#${name}"></use></svg>`;
  const shortId = (id) => String(id || '').replace(/-/g, '').substring(0, 7).toUpperCase();
  const n = (x) => new Intl.NumberFormat('es-MX').format(x);
  const dt = (x) => { if (!x) return ''; const d = new Date(x); return Number.isNaN(+d) ? '' : new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(d); };
  const badge = (status) => `<span class="status ${esc(status)}">${svg(icons[status] || 'i-key')}${esc(names[status] || status)}</span>`;

  function view(which) {
    for (const id of ['bootView', 'setupView', 'loginView', 'pendingView', 'errorView', 'vaultView']) $(id).hidden = (id !== which);
    $('logoutBtn').hidden = !(which === 'vaultView' || which === 'pendingView');
  }
  function toast(message, bad = false) {
    const el = $('toast');
    clearTimeout(state.toastTimeout);
    el.textContent = message;
    el.classList.toggle('bad', bad);
    el.hidden = false;
    state.toastTimeout = setTimeout(() => { el.hidden = true; }, 4200);
  }
  function friendly(err) {
    const raw = String(err?.message || err || 'Error inesperado');
    if (/Invalid login credentials/i.test(raw)) return 'El correo o la contraseña no coinciden.';
    if (/Email not confirmed|email_not_confirmed/i.test(raw)) return 'Confirma tu correo para iniciar sesión.';
    if (/Password should be at least/i.test(raw)) return 'La contraseña debe tener al menos 8 caracteres.';
    if (/User already registered/i.test(raw)) return 'Ese correo ya tiene una cuenta. Prueba iniciar sesión.';
    if (/rate limit|email rate limit/i.test(raw)) return 'Límite de correos alcanzado. Intenta más tarde.';
    if (/Error sending confirmation email|only send.*authorized/i.test(raw)) return 'No se pudo enviar el correo. Hay que configurar el SMTP de Supabase.';
    if (/ACCESS_DENIED|permission denied/i.test(raw)) return 'Tu cuenta no tiene acceso a esta sección.';
    if (/NOT_AVAILABLE/i.test(raw)) return 'Esta key ya fue tomada. Prueba con otra.';
    if (/duplicate key|unique constraint|23505/i.test(raw)) return 'Hay un dato duplicado, o falta aplicar la migración V3 para varias keys.';
    if (/does not exist|could not find the function|schema cache/i.test(raw)) return 'Falta instalar la migración SQL o revisar la configuración de Supabase.';
    if (/Failed to fetch|NetworkError|fetch failed/i.test(raw)) return 'No hay conexión. Revisa tu internet e intenta otra vez.';
    return raw;
  }
  function errorView(err) {
    console.error('[CHINO V3]', err);
    $('errorText').textContent = friendly(err);
    view('errorView');
  }

  function authMode(mode) {
    state.mode = mode;
    document.querySelectorAll('[data-auth-mode]').forEach(b => b.classList.toggle('selected', b.dataset.authMode === mode));
    $('authHeading').textContent = mode === 'login' ? 'Bienvenido de nuevo' : 'Crea tu cuenta';
    $('authHelp').textContent = mode === 'login' ? 'Inicia sesión para ver las keys disponibles.' : 'Regístrate y espera la aprobación del administrador.';
    $('authSubmit').innerHTML = mode === 'login' ? `Entrar ${svg('i-arrow')}` : `Crear cuenta ${svg('i-arrow')}`;
    $('authFoot').textContent = mode === 'login' ? 'El inventario es privado. Solo entran los correos autorizados.' : 'Crear una cuenta no da acceso automáticamente.';
    $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('authMessage').hidden = true;
  }
  function formNote(msg, bad = false) {
    const box = $('authMessage'); box.hidden = false; box.classList.toggle('bad', bad); box.textContent = msg;
  }
  function tab(name) {
    if (name === 'admin' && state.role !== 'admin') name = 'stock';
    state.tab = name;
    for (const id of ['stock', 'mine', 'admin']) {
      $(id + 'Panel').hidden = (id !== name);
    }
    document.querySelectorAll('[data-tab]').forEach((button) => {
      const selected = button.dataset.tab === name;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
    });
  }
  function empty(title, detail, icon = 'i-package') {
    return `<div class="empty-state">${svg(icon)}<strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`;
  }

  function renderStock() {
    const list = state.inventory.filter((k) =>
      (state.filter === 'all' || k.status === state.filter) &&
      String(k.plan).toLocaleLowerCase('es').includes(state.search)
    );
    $('shownCount').textContent = `${n(list.length)} ${list.length === 1 ? 'key' : 'keys'}`;
    $('inventory').innerHTML = list.length ? list.map((k) => {
      const canClaim = k.status === 'available';
      return `<article class="stock-card">
        <div class="stock-card-head"><div class="stock-card-symbol">${svg('i-key')}</div>${badge(k.status)}</div>
        <div><h3>${esc(k.plan)}</h3><small>REF / ${esc(shortId(k.id))}</small></div>
        <button type="button" class="stock-action" data-claim="${esc(k.id)}" ${canClaim ? '' : 'disabled'}>
          <span>${canClaim ? 'Copiar key' : k.status === 'full' ? 'Ya usada' : 'No disponible'}</span>${svg(canClaim ? 'i-copy' : 'i-lock')}
        </button>
      </article>`;
    }).join('') : empty('Sin resultados', state.search ? 'Prueba con otro nombre.' : 'Cuando haya keys aquí podrás verlas.', 'i-search');
  }
  function renderMine() {
    $('mineCount').textContent = n(state.owned.length);
    $('ownedKeys').innerHTML = state.owned.length ? state.owned.map((k) => `<article class="owned-card">
      <div class="owned-top"><h3>${esc(k.plan)}</h3>${badge('full')}</div>
      <p class="owned-meta">Entregada ${esc(dt(k.claimed_at) || 'recientemente')}</p>
      <div class="code-box"><code>${esc(k.code)}</code><button type="button" data-copy-owned="${esc(k.id)}" aria-label="Copiar key" title="Copiar key">${svg('i-copy')}</button></div>
    </article>`).join('') : empty('Todavía no has tomado ninguna', 'Las keys que copies se guardarán aquí.', 'i-key');
  }
  function renderAdmin() {
    $('approvals').innerHTML = state.approvals.length ? state.approvals.map((a) => `<div class="approval-item"><span>${esc(a.email)}</span><button class="tiny-button" type="button" data-revoke="${esc(a.email)}">Quitar</button></div>`).join('') : `<p class="help-text">No hay correos autorizados todavía.</p>`;
    $('adminTotal').textContent = `${n(state.keys.length)} KEYS`;
    $('adminKeys').innerHTML = state.keys.length ? state.keys.map((k) => `<div class="admin-row">
      <div><strong>${esc(k.plan)} ${badge(k.status)}</strong><small>${esc(k.code)}${k.claimed_by ? ' · entregada' : ''}${k.claimed_at ? ' · ' + esc(dt(k.claimed_at)) : ''}</small></div>
      <select data-status="${esc(k.id)}" aria-label="Estado de ${esc(k.plan)}">
        <option value="available" ${k.status === 'available' ? 'selected' : ''}>Disponible</option>
        <option value="full" ${k.status === 'full' ? 'selected' : ''}>Usada</option>
        <option value="reserved" ${k.status === 'reserved' ? 'selected' : ''}>Reservada</option>
      </select>
      <button type="button" class="tiny-button" data-delete="${esc(k.id)}" aria-label="Eliminar key">${svg('i-trash')}</button>
    </div>`).join('') : empty('Tu inventario está vacío', 'Agrega tus primeras keys desde el formulario.', 'i-plus');
  }
  function render() {
    $('rolePill').textContent = state.role === 'admin' ? 'OWNER' : 'AUTORIZADO';
    $('welcomeEmail').textContent = state.user?.email || '';
    $('adminTab').hidden = state.role !== 'admin';
    const inv = state.inventory;
    $('totalCount').textContent = n(inv.length);
    $('availableCount').textContent = n(inv.filter(k => k.status === 'available').length);
    $('usedCount').textContent = n(inv.filter(k => k.status === 'full').length);
    $('reservedCount').textContent = n(inv.filter(k => k.status === 'reserved').length);
    renderStock(); renderMine(); if (state.role === 'admin') renderAdmin();
    tab(state.tab);
  }

  async function loadSDK() {
    if (window.supabase?.createClient) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      script.onload = () => window.supabase?.createClient ? resolve() : reject(new Error('Supabase no se cargó.'));
      script.onerror = () => reject(new Error('No se pudo cargar Supabase. Revisa la conexión.'));
      document.head.append(script);
    });
  }

  // Una actualización a la vez: evita que se crucen respuestas del servidor.
  async function gate(quiet = false) {
    if (!state.client) return;
    if (state.loading) { state.refreshQueued = true; return; }
    state.loading = true;
    if (!quiet) view('bootView');
    try {
      const { data: auth, error: authError } = await state.client.auth.getUser();
      if (authError && !/Auth session missing/i.test(authError.message)) throw authError;
      state.user = auth?.user || null;
      if (!state.user) {
        state.role = null; state.inventory = []; state.owned = []; state.keys = []; state.approvals = [];
        view('loginView'); return;
      }
      const { data: role, error: roleError } = await state.client.rpc('chino_access_status');
      if (roleError) throw roleError;
      state.role = role;
      if (!['admin', 'approved'].includes(role)) {
        state.inventory = []; state.owned = []; state.keys = []; state.approvals = [];
        $('pendingEmail').textContent = state.user.email || 'Cuenta pendiente';
        view('pendingView'); return;
      }
      const queries = [
        state.client.rpc('chino_inventory'),
        state.client.from('chino_keys').select('id,plan,code,status,claimed_at,created_at').eq('claimed_by', state.user.id).order('claimed_at', { ascending: false })
      ];
      if (role === 'admin') {
        queries.push(state.client.from('chino_keys').select('id,plan,code,status,claimed_by,claimed_at,created_at').order('created_at', { ascending: false }));
        queries.push(state.client.from('chino_allowed_emails').select('email,created_at').order('created_at', { ascending: false }));
      }
      const results = await Promise.all(queries);
      const problem = results.find((r) => r.error)?.error;
      if (problem) throw problem;
      state.inventory = results[0].data || [];
      state.owned = results[1].data || [];
      state.keys = role === 'admin' ? results[2].data || [] : [];
      state.approvals = role === 'admin' ? results[3].data || [] : [];
      render(); view('vaultView');
      if (!quiet) window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (err) { errorView(err); }
    finally {
      state.loading = false;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        setTimeout(() => gate(true), 60);
      }
    }
  }

  async function login(event) {
    event.preventDefault();
    const email = $('email').value.trim().toLowerCase();
    const password = $('password').value;
    const button = $('authSubmit');
    button.disabled = true;
    try {
      if (state.mode === 'register') {
        const { data, error } = await state.client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (data?.session) {
          formNote('Cuenta creada. Tu acceso está pendiente de aprobación.');
          await gate();
        } else {
          formNote('Cuenta creada. Revisa tu correo para confirmarla; después podrás iniciar sesión.');
        }
      } else {
        const { error } = await state.client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await gate();
      }
    } catch (err) { formNote(friendly(err), true); }
    finally { button.disabled = false; }
  }

  async function copyText(code) {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(code); return true;
      }
    } catch (_) { /* Safari u otro navegador puede impedir el portapapeles. */ }
    const t = document.createElement('textarea');
    t.value = code;
    t.style.position = 'fixed'; t.style.opacity = '0'; t.style.top = '0';
    document.body.appendChild(t); t.focus(); t.select(); t.setSelectionRange(0, code.length);
    let success = false;
    try { success = document.execCommand('copy'); } catch (_) { success = false; }
    t.remove();
    return success;
  }
  function showClaim(key, copied) {
    state.lastClaim = key;
    $('dialogBody').innerHTML = `<div class="state-icon">${svg('i-check')}</div>
      <p class="eyebrow">KEY ENTREGADA</p><h2 id="dialogTitle">Ya es tuya.</h2>
      <p>${copied ? 'Copiada al portapapeles y marcada como usada.' : 'Se marcó como usada. Si no se copió automáticamente, usa el botón de abajo.'}</p>
      <div class="dialog-code">${esc(key.code)}</div>
      <button type="button" class="button primary full" id="copyDialogKey">${svg('i-copy')} Copiar código</button>
      <button type="button" class="button ghost full" id="myKeysDialog">Ver mis keys ${svg('i-arrow')}</button>
      <p class="dialog-note">Puedes volver a copiarla desde «Mis keys». La entrega queda registrada.</p>`;
    $('dialog').hidden = false;
    $('copyDialogKey').addEventListener('click', async () => {
      if (await copyText(key.code)) toast('Key copiada');
      else toast('No se pudo copiar. Mantén presionado el código para seleccionarlo.', true);
    });
    $('myKeysDialog').addEventListener('click', () => { closeDialog(); tab('mine'); });
    $('closeDialog').focus();
  }
  async function claim(id) {
    if (!['admin', 'approved'].includes(state.role) || state.claimBusy.has(id)) return;
    const key = state.inventory.find(k => k.id === id);
    if (!key || key.status !== 'available') { toast('Esta key ya no está disponible.', true); return; }
    state.claimBusy.add(id);
    const button = [...$('inventory').querySelectorAll('[data-claim]')].find(b => b.dataset.claim === id);
    if (button) { button.disabled = true; button.textContent = 'Entregando...'; }
    try {
      // Operación ATÓMICA: al recibir el código, el servidor ya cambió el estado.
      // El portapapeles puede bloquearse en iOS; por eso la key también se guarda en «Mis keys».
      const { data, error } = await state.client.rpc('chino_claim', { p_key_id: id });
      if (error) throw error;
      const delivered = data?.[0];
      if (!delivered?.code) throw new Error('NOT_AVAILABLE');
      const copied = await copyText(delivered.code);
      await gate(true);
      showClaim(delivered, copied);
      if (copied) toast('Key copiada · marcada como usada');
    } catch (err) { toast(friendly(err), true); await gate(true); }
    finally { state.claimBusy.delete(id); }
  }
  function closeDialog() { $('dialog').hidden = true; $('dialogBody').replaceChildren(); state.lastClaim = null; }

  async function addKeys(event) {
    event.preventDefault(); if (state.role !== 'admin') return;
    const form = event.currentTarget;
    const plan = form.elements.plan.value.trim();
    const codes = [...new Set(form.elements.codes.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    if (!plan || !codes.length || codes.length > 50 || codes.some(s => s.length > 300)) {
      toast('Agrega de 1 a 50 keys, una por línea.', true); return;
    }
    const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try {
      const { error } = await state.client.from('chino_keys').insert(codes.map(code => ({ plan, code, status: 'available' })));
      if (error) throw error;
      form.reset(); toast(`${codes.length} ${codes.length === 1 ? 'key agregada' : 'keys agregadas'}`);
      await gate(true);
    } catch (err) { toast(friendly(err), true); }
    finally { button.disabled = false; }
  }
  async function approve(event) {
    event.preventDefault(); if (state.role !== 'admin') return;
    const form = event.currentTarget; const email = form.elements.email.value.trim().toLowerCase();
    if (!email || email.length > 254) return;
    const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try {
      const { error } = await state.client.from('chino_allowed_emails').insert({ email });
      if (error) throw error;
      form.reset(); toast('Correo autorizado'); await gate(true);
    } catch (err) { toast(friendly(err), true); }
    finally { button.disabled = false; }
  }
  async function revoke(email) {
    if (state.role !== 'admin' || !confirm(`¿Quitar el acceso a ${email}?`)) return;
    try {
      const { error } = await state.client.from('chino_allowed_emails').delete().eq('email', email);
      if (error) throw error;
      toast('Acceso retirado'); await gate(true);
    } catch (err) { toast(friendly(err), true); }
  }
  async function updateStatus(id, status) {
    if (state.role !== 'admin' || !names[status]) return;
    const k = state.keys.find(x => x.id === id);
    if (!k || k.status === status) return;
    if (k.claimed_by && status !== 'full') {
      if (!confirm('Esta key ya se entregó. Liberarla permitirá que otra persona la tome, pero NO revoca el código externo. ¿Continuar?')) {
        renderAdmin(); return;
      }
    }
    const patch = { status };
    if (status !== 'full') { patch.claimed_by = null; patch.claimed_at = null; }
    try {
      const { error } = await state.client.from('chino_keys').update(patch).eq('id', id);
      if (error) throw error;
      toast('Estado actualizado'); await gate(true);
    } catch (err) { toast(friendly(err), true); renderAdmin(); }
  }
  async function removeKey(id) {
    if (state.role !== 'admin' || !confirm('¿Eliminar esta key del inventario? No cancela licencias externas.')) return;
    try {
      const { error } = await state.client.from('chino_keys').delete().eq('id', id);
      if (error) throw error;
      toast('Key eliminada'); await gate(true);
    } catch (err) { toast(friendly(err), true); }
  }
  async function logout() {
    try {
      const { error } = await state.client.auth.signOut();
      if (error) throw error;
      state.user = null; state.role = null; state.inventory = []; state.owned = []; state.keys = []; state.approvals = [];
      tab('stock'); view('loginView'); toast('Sesión cerrada');
    } catch (err) { toast(friendly(err), true); }
  }

  async function init() {
    $('authForm').addEventListener('submit', login);
    document.querySelectorAll('[data-auth-mode]').forEach(b => b.addEventListener('click', () => authMode(b.dataset.authMode)));
    $('showPassword').addEventListener('click', () => {
      const input = $('password'); const on = input.type === 'password'; input.type = on ? 'text' : 'password';
      $('showPassword').innerHTML = svg(on ? 'i-eyeoff' : 'i-eye');
      $('showPassword').setAttribute('aria-label', on ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
    $('logoutBtn').addEventListener('click', logout); $('pendingLogout').addEventListener('click', logout);
    $('checkApproval').addEventListener('click', () => gate()); $('retryBtn').addEventListener('click', () => gate());
    $('refreshBtn').addEventListener('click', () => gate(true));
    $('mainNav').addEventListener('click', (event) => { const b = event.target.closest('[data-tab]'); if (b) tab(b.dataset.tab); });
    $('filters').addEventListener('click', (event) => {
      const b = event.target.closest('[data-filter]'); if (!b) return;
      state.filter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('selected', x === b));
      renderStock();
    });
    $('stockSearch').addEventListener('input', (event) => { state.search = event.target.value.trim().toLocaleLowerCase('es'); renderStock(); });
    $('inventory').addEventListener('click', (event) => { const b = event.target.closest('[data-claim]'); if (b) claim(b.dataset.claim); });
    $('ownedKeys').addEventListener('click', async (event) => {
      const b = event.target.closest('[data-copy-owned]'); if (!b) return;
      const k = state.owned.find(x => x.id === b.dataset.copyOwned);
      if (k) toast(await copyText(k.code) ? 'Key copiada' : 'Cópiala seleccionando el texto.', false);
    });
    $('addKeysForm').addEventListener('submit', addKeys); $('approveForm').addEventListener('submit', approve);
    $('approvals').addEventListener('click', (event) => { const b = event.target.closest('[data-revoke]'); if (b) revoke(b.dataset.revoke); });
    $('adminKeys').addEventListener('click', (event) => { const b = event.target.closest('[data-delete]'); if (b) removeKey(b.dataset.delete); });
    $('adminKeys').addEventListener('change', (event) => { const b = event.target.closest('[data-status]'); if (b) updateStatus(b.dataset.status, b.value); });
    $('closeDialog').addEventListener('click', closeDialog);
    $('dialog').addEventListener('click', (event) => { if (event.target === $('dialog')) closeDialog(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('dialog').hidden) closeDialog(); });

    if (!cfg.supabaseUrl?.startsWith('https://') || !/^(sb_publishable_|eyJ)/.test(cfg.supabaseAnonKey || '')) {
      $('setupError').textContent = 'Revisa la URL y la Publishable Key pública en config.js.';
      view('setupView'); return;
    }
    try {
      await loadSDK();
      state.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      state.client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
          if ((state.user?.id || null) !== (session?.user?.id || null)) setTimeout(() => gate(true), 30);
        }
      });
      await gate();
      setInterval(() => { if (!document.hidden && state.user) gate(true); }, intervalMs);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) gate(true); });
    } catch (err) { errorView(err); }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
