(() => {
  'use strict';

  const CONFIG = window.CHINO_CONFIG || {};
  const DEMO = !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey || CONFIG.supabaseUrl.includes('PON_AQUI') || CONFIG.supabaseAnonKey.includes('PON_AQUI');
  const REFRESH_MS = Math.max(5, Number(CONFIG.refreshSeconds) || 10) * 1000;
  const DEMO_KEY = 'chino_v1_demo_inventory';
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m0-5-4 4m-3-3 4-4"/></svg>';
  const $ = (q) => document.querySelector(q);
  const $$ = (q) => Array.from(document.querySelectorAll(q));
  const safe = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const shortId = (id) => String(id || '').replace(/-/g,'').slice(0,8).toUpperCase();
  const names = { available:'AVAILABLE', full:'FULL', reserved:'RESERVED' };
  const descriptions = {available:'Lista para reclamar',full:'Ya fue reclamada',reserved:'Apartada temporalmente'};
  let client = null;
  const state = { inventory:[], owned:[], adminKeys:[], user:null, isAdmin:DEMO, filter:'all', query:'', loading:false, hasLoaded:false };

  function demoSeed(){
    return [
      ['PERMANENT KEY','available'],['WEEKLY KEY','available'],['PERMANENT KEY','full'],
      ['MONTHLY KEY','available'],['DAILY KEY','full'],['WEEKLY KEY','reserved'],
      ['MONTHLY KEY','available'],['PERMANENT KEY','full'],['DAILY KEY','available']
    ].map(([plan,status],i)=>({id:`demo-0${i+1}`,plan,status,code:`DEMO-KEY-${String(i+1).padStart(4,'0')}-NO-VALIDA`,claimed_by:null,claimed_at:null,created_at:new Date(Date.now()-i*450000).toISOString()}));
  }
  function demoLoad(){
    try { const v = JSON.parse(localStorage.getItem(DEMO_KEY)); if (Array.isArray(v)) return v; }
    catch (_) { /* fallback */ }
    const initial=demoSeed();demoSave(initial);return initial;
  }
  function demoSave(data){try {localStorage.setItem(DEMO_KEY,JSON.stringify(data));} catch (_) {}}
  function showToast(message,type='normal'){
    const item=document.createElement('div');item.className=`toast ${type}`;item.textContent=message;$('#toastContainer').appendChild(item);
    setTimeout(()=>{item.style.opacity='0';item.style.transition='opacity .22s';setTimeout(()=>item.remove(),220);},4100);
  }
  function setSync(label,isDemo=false){$('#syncLabel').textContent=label;$('.pulse-dot').classList.toggle('demo',isDemo);}
  function showModal(html){$('#modalContent').innerHTML=html;$('#modalOverlay').hidden=false;document.body.style.overflow='hidden';setTimeout(()=>$('.modal input, .modal textarea, .modal button:not(.modal-close)')?.focus(),40);}
  function closeModal(){$('#modalOverlay').hidden=true;document.body.style.overflow='';$('#modalContent').innerHTML='';}
  function heading(kicker,title,description){return `<div class="modal-kicker">${kicker}</div><h2 id="modalTitle">${title}</h2><p class="modal-description">${description}</p>`;}
  function scrollToSection(id){document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});}
  async function copyText(value){
    try {
      if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.select();if(!document.execCommand('copy'))throw new Error('Copy failed');input.remove();}
      showToast('Key copiada al portapapeles ✓','success');
    } catch {showToast('No se pudo copiar automáticamente. Selecciona y copia la key.','error');}
  }
  function readableError(error){
    const msg=String(error?.message || error || 'Error inesperado');
    if(msg.includes('ALREADY_CLAIMED'))return 'Ya reclamaste una key con esta cuenta. Solo se permite una por persona.';
    if(msg.includes('NOT_AVAILABLE'))return 'Esta key ya no está disponible. Actualiza el inventario.';
    if(msg.includes('LOGIN_REQUIRED')||msg.includes('JWT'))return 'Inicia sesión para reclamar una key.';
    if(msg.includes('duplicate key'))return 'Una de esas keys ya existe. Revisa los códigos repetidos.';
    if(msg.includes('permission denied')||msg.includes('row-level security'))return 'Sin permisos. Revisa si tu correo ya fue agregado como administrador.';
    return msg;
  }

  function loadSupabaseSdk(){
    if(window.supabase?.createClient)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      script.onload=()=>window.supabase?.createClient?resolve():reject(new Error('SDK de Supabase inválido'));
      script.onerror=()=>reject(new Error('No se pudo cargar Supabase; revisa tu conexión a Internet'));
      document.head.appendChild(script);
    });
  }

  async function init(){
    $('#modalClose').addEventListener('click',closeModal);
    $('#modalOverlay').addEventListener('click',(e)=>{if(e.target.id==='modalOverlay')closeModal();});
    document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeModal();});
    $('#heroBrowse').addEventListener('click',()=>scrollToSection('explorar'));
    $('#heroMine').addEventListener('click',openMine);
    $('#accountBtn').addEventListener('click',openAccount);
    $('#refreshBtn').addEventListener('click',()=>refresh(true));
    $$('.tab').forEach((btn)=>btn.addEventListener('click',()=>{state.filter=btn.dataset.filter;$$('.tab').forEach(b=>b.classList.toggle('active',b===btn));renderInventory();}));
    $('#searchInput').addEventListener('input',(e)=>{state.query=e.target.value.toLowerCase().trim();renderInventory();});
    $('#catalog').addEventListener('click',(e)=>{const button=e.target.closest('[data-claim]');if(button)confirmClaim(button.dataset.claim);});
    $('#myKeysGrid').addEventListener('click',(e)=>{const button=e.target.closest('[data-copy-id]');if(button){const key=state.owned.find(k=>k.id===button.dataset.copyId);if(key)copyText(key.code);}});
    $('#adminList').addEventListener('change',(e)=>{if(e.target.matches('[data-change-status]'))updateStatus(e.target.dataset.changeStatus,e.target.value);});
    $('#adminList').addEventListener('click',(e)=>{const button=e.target.closest('[data-delete]');if(button)deleteKey(button.dataset.delete);});
    $('#addKeysBtn').addEventListener('click',showAddKeys);
    $('#modalContent').addEventListener('click',handleModalClick);
    $('#modalContent').addEventListener('submit',handleModalSubmit);

    if(DEMO){
      const banner=document.createElement('div');banner.className='demo-banner';banner.innerHTML='<strong>⚡ MODO DEMO</strong> Esta vista tiene keys de ejemplo. Los cambios se guardan solo en este navegador, no se comparten entre amigos.';
      $('.topbar').insertAdjacentElement('afterend',banner);
      state.user={id:'demo-local',email:'demo@chino.local'};
      setSync('DEMO LOCAL',true);
      await refresh();
    } else {
      try { await loadSupabaseSdk(); }
      catch(err) {setSync('SIN CONEXIÓN');showToast(readableError(err),'error');return;}
      client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabaseAnonKey, { auth:{detectSessionInUrl:true, persistSession:true, autoRefreshToken:true} });
      const {data,error}=await client.auth.getSession();
      if(error)showToast(readableError(error),'error');
      state.user=data?.session?.user || null;
      client.auth.onAuthStateChange((_event,session)=>{
        const nextId=session?.user?.id||null;
        if((state.user?.id||null)!==nextId){state.user=session?.user||null;state.isAdmin=false;setTimeout(()=>refresh(),0);}
      });
      await refresh();
      setInterval(()=>{if(!document.hidden)refresh(false);},REFRESH_MS);
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(false);});
    }
  }

  async function refresh(loud=false){
    if(state.loading)return;
    state.loading=true;
    $('#refreshBtn').disabled=true;
    try {
      if(DEMO){
        const data=demoLoad();state.inventory=data.map(({id,plan,status,created_at})=>({id,plan,status,created_at}));
        state.owned=data.filter(k=>k.claimed_by==='demo-local');state.adminKeys=data;
        state.isAdmin=true;
      } else {
        const {data,error}=await client.rpc('chino_inventory');
        if(error)throw error;
        state.inventory=data||[];
        if(state.user){
          const [{data:adminFlag,error:flagError},{data:owned,error:ownedError}]=await Promise.all([
            client.rpc('chino_is_admin'),
            client.from('chino_keys').select('id,plan,code,status,claimed_by,claimed_at,created_at').eq('claimed_by',state.user.id).order('created_at',{ascending:false})
          ]);
          if(flagError)throw flagError;
          if(ownedError)throw ownedError;
          state.isAdmin=!!adminFlag;
          state.owned=owned||[];
          if(state.isAdmin){
            const {data:all,error:adminError}=await client.from('chino_keys').select('id,plan,code,status,claimed_by,created_at').order('created_at',{ascending:false});
            if(adminError)throw adminError;
            state.adminKeys=all||[];
          } else state.adminKeys=[];
        } else {state.isAdmin=false;state.owned=[];state.adminKeys=[];}
        setSync('SYNC / '+(REFRESH_MS/1000)+'S');
      }
      state.hasLoaded=true;
      renderAll();
      if(loud)showToast('Inventario actualizado ✓','success');
    } catch(e){
      console.error('[CHINO] Error al sincronizar:',e);
      setSync('ERROR DE CONEXIÓN');
      if(!state.hasLoaded)$('#catalog').innerHTML='<div class="empty"><div class="empty-symbol">!</div><h3>No se pudo cargar</h3><p>Revisa la configuración y ejecuta database.sql en Supabase.</p></div>';
      if(loud||!state.hasLoaded)showToast('Error de sincronización: '+readableError(e),'error');
    } finally {state.loading=false;$('#refreshBtn').disabled=false;}
  }

  function renderAll(){
    const keys=state.inventory;
    $('#countTotal').textContent=keys.length;
    $('#countAvailable').textContent=keys.filter(k=>k.status==='available').length;
    $('#countFull').textContent=keys.filter(k=>k.status==='full').length;
    $('#countReserved').textContent=keys.filter(k=>k.status==='reserved').length;
    $('#accountLabel').textContent=DEMO?'Modo demo':(state.user?.email || 'Iniciar sesión');
    $('#accountInitial').textContent=state.user?.email?.[0]?.toUpperCase() || '↗';
    $('#myKeysSection').hidden=!state.user;
    $('#adminSection').hidden=!state.isAdmin;
    renderInventory();renderOwned();renderAdmin();
  }
  function renderInventory(){
    const items=state.inventory.filter(k=>(state.filter==='all'||k.status===state.filter)&&String(k.plan).toLowerCase().includes(state.query));
    $('#catalog').innerHTML=items.length?items.map((k)=>`
      <article class="key-card">
        <div class="card-top"><span class="code-mark">${ICON}</span><span class="status-badge ${safe(k.status)}">● ${names[k.status]||'UNKNOWN'}</span></div>
        <h3 class="card-plan">${safe(k.plan)}</h3><div class="card-id">KEY ID / ${safe(shortId(k.id))}</div>
        <div class="card-bottom"><span class="card-caption ${safe(k.status)}">${descriptions[k.status]||'Estado desconocido'}</span>
        <button class="card-action" data-claim="${safe(k.id)}" ${k.status!=='available'?'disabled':''}>${k.status==='available'?'Reclamar ↗':'No disponible'}</button></div>
      </article>`).join(''):
      '<div class="empty"><div class="empty-symbol">◇</div><h3>Sin resultados</h3><p>No hay keys con ese filtro por ahora.</p></div>';
  }
  function renderOwned(){
    $('#myKeysGrid').innerHTML=state.owned.length?state.owned.map((k)=>`
      <article class="key-card"><div class="card-top"><span class="code-mark">${ICON}</span><span class="status-badge full">● TU KEY</span></div>
      <h3 class="card-plan">${safe(k.plan)}</h3><div class="card-id">${safe(k.code)}</div>
      <div class="card-bottom"><span class="card-caption">Código entregado</span><button class="card-action" data-copy-id="${safe(k.id)}">Copiar key ↗</button></div></article>`).join(''):
      '<div class="empty"><div class="empty-symbol">◇</div><h3>Aún no tienes keys</h3><p>Reclama una key disponible y aparecerá aquí.</p></div>';
  }
  function renderAdmin(){
    $('#adminCount').textContent=`${state.adminKeys.length} registros`;
    $('#adminList').innerHTML=state.adminKeys.length?state.adminKeys.map(k=>`
      <div class="admin-row"><div class="admin-row-main"><strong>${safe(k.plan)} <span class="status-badge ${safe(k.status)}">${names[k.status]}</span></strong>
      <small title="${safe(k.code)}">${safe(k.code)} ${k.claimed_by?' · RECLAMADA':''}</small></div>
      <select class="admin-row-select" data-change-status="${safe(k.id)}" aria-label="Cambiar estado de ${safe(k.plan)}">
      <option value="available" ${k.status==='available'?'selected':''}>🟢 Available</option>
      <option value="full" ${k.status==='full'?'selected':''}>🔴 Full</option>
      <option value="reserved" ${k.status==='reserved'?'selected':''}>🟡 Reserved</option></select>
      <button type="button" class="admin-delete" data-delete="${safe(k.id)}">Eliminar</button></div>`).join(''):'<div class="admin-empty">No hay keys. Agrega la primera desde el botón superior.</div>';
  }

  function openAccount(){
    if(state.user){
      showModal(heading('// ACCOUNT','Tu cuenta','Sesión activa: <strong>'+safe(state.user.email)+'</strong>')+
        `<button id="logoutBtn" type="button" class="ghost-button" style="width:100%;">${DEMO?'Restablecer la demo':'Cerrar sesión'} ↗</button>`);
    } else showLogin();
  }
  function showLogin(){
    if(DEMO){showToast('En modo demo no necesitas iniciar sesión.','success');return;}
    showModal(heading('// ACCESS','Iniciar sesión','Escribe tu correo. Te enviaremos un enlace de acceso para reclamar y consultar tus keys.')+
      '<form id="loginForm"><label class="form-group"><span>TU CORREO</span><input class="form-field" type="email" name="email" autocomplete="email" placeholder="tu@correo.com" maxlength="250" required /></label><button class="primary-button" type="submit">Enviar enlace de acceso ↗</button></form><p class="modal-note">Solo tú podrás ver el código de la key que reclames. Revisa tu correo y también Spam.</p>');
  }
  function openMine(){
    if(!state.user){showLogin();return;}
    scrollToSection('myKeysSection');
  }
  function confirmClaim(id){
    const key=state.inventory.find(k=>k.id===id);
    if(!key || key.status!=='available'){showToast('Esa key ya no está disponible.','error');return;}
    if(!state.user){showLogin();return;}
    if(state.owned.length&&!state.isAdmin){showToast('Ya reclamaste una key con esta cuenta.','error');openMine();return;}
    showModal(heading('// CLAIM KEY','¿Reclamar esta key?','Se entregará únicamente a tu cuenta y se marcará como FULL para todos.')+
      `<div class="confirm-card"><strong>${safe(key.plan)}</strong><br><span style="color:#a99abb;font-size:11px">ID / ${safe(shortId(key.id))}</span></div>`+
      `<button type="button" class="primary-button" data-confirm-claim="${safe(key.id)}">Sí, reclamar mi key ↗</button><p class="modal-note">Solo se permite una key reclamada por cuenta. Esta acción no se deshace desde tu perfil.</p>`);
  }
  async function performClaim(id,btn){
    btn.disabled=true;btn.textContent='Reclamando…';
    try {
      let obtained;
      if(DEMO){
        const list=demoLoad();
        if(list.some(k=>k.claimed_by==='demo-local'))throw new Error('ALREADY_CLAIMED');
        const key=list.find(k=>k.id===id&&k.status==='available');
        if(!key)throw new Error('NOT_AVAILABLE');
        key.status='full';key.claimed_by='demo-local';key.claimed_at=new Date().toISOString();demoSave(list);obtained=key;
      }else{
        const {data,error}=await client.rpc('chino_claim',{p_key_id:id});
        if(error)throw error;
        obtained=data?.[0];
        if(!obtained)throw new Error('NOT_AVAILABLE');
      }
      await refresh();
      showSecret(obtained);
      showToast('¡Key reclamada correctamente!','success');
    } catch(e){showToast(readableError(e),'error');btn.disabled=false;btn.textContent='Intentar nuevamente ↗';await refresh();}
  }
  function showSecret(k){
    showModal(heading('// ACCESS GRANTED','¡Esta key es tuya!','Ya quedó marcada como FULL. Guarda este código en un lugar seguro.')+
      `<div class="secret-box"><code id="secretText">${safe(k.code)}</code><button class="copy-button" id="secretCopyBtn">Copiar</button></div>`+
      '<button type="button" class="primary-button" id="goMineBtn">Ver mis keys ↗</button>'+
      (DEMO?'<p class="modal-note">IMPORTANTE: Este código es de demostración; no es una licencia real.</p>':''));
  }
  function showAddKeys(){
    if(!state.isAdmin){showToast('Solo el administrador puede añadir keys.','error');return;}
    showModal(heading('// OWNER CONSOLE','Agregar keys','Pega tus keys reales. Puedes agregar varias a la vez, una por línea.')+
      '<form id="addKeysForm"><label class="form-group"><span>TIPO DE KEY</span><input class="form-field" name="plan" maxlength="80" placeholder="Ej. PERMANENT KEY, WEEKLY KEY" required /></label><label class="form-group"><span>CÓDIGOS (UNO POR LÍNEA)</span><textarea class="form-field textarea-field" name="codes" placeholder="KEY-REAL-1\nKEY-REAL-2\nKEY-REAL-3" maxlength="10000" required></textarea></label><button type="submit" class="primary-button">Agregar al inventario ↗</button></form><p class="modal-note">Ningún visitante podrá ver estas keys hasta reclamarlas. Nunca pegues aquí una clave privada del proyecto Supabase.</p>');
  }
  async function addKeys(form){
    const plan=form.elements.plan.value.trim();
    const codes=[...new Set(form.elements.codes.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];
    if(!plan || !codes.length){showToast('Escribe el tipo y al menos una key.','error');return;}
    if(codes.some(c=>c.length>300)){showToast('Una key tiene más de 300 caracteres.','error');return;}
    if(codes.length>50){showToast('Agrega máximo 50 keys por operación.','error');return;}
    const button=form.querySelector('button[type="submit"]');button.disabled=true;button.textContent='Agregando…';
    try {
      if(DEMO){const data=demoLoad();for(const code of codes){if(data.some(k=>k.code===code))throw Error('duplicate key');data.unshift({id:'demo-'+crypto.randomUUID(),plan,code,status:'available',claimed_by:null,claimed_at:null,created_at:new Date().toISOString()});}demoSave(data);}
      else {const {error}=await client.from('chino_keys').insert(codes.map(code=>({plan,code,status:'available'})));if(error)throw error;}
      closeModal();await refresh();showToast(`${codes.length} key(s) agregada(s) ✓`,'success');scrollToSection('adminSection');
    }catch(e){showToast(readableError(e),'error');button.disabled=false;button.textContent='Agregar al inventario ↗';}
  }
  async function updateStatus(id,status){
    if(!state.isAdmin)return;
    const old=state.adminKeys.find(k=>k.id===id);
    if(!old||old.status===status)return;
    if(old.claimed_by && status!=='full'){
      if(!window.confirm('Esta key fue reclamada. Cambiarla quitará su acceso a la key dentro de esta web (NO revoca una licencia externa). ¿Continuar?')){renderAdmin();return;}
    }
    try{
      if(DEMO){const data=demoLoad();const key=data.find(k=>k.id===id);if(!key)throw Error('Key no encontrada');key.status=status;if(status!=='full'){key.claimed_by=null;key.claimed_at=null;}demoSave(data);}
      else {const update={status};if(status!=='full'){update.claimed_by=null;update.claimed_at=null;}const {error}=await client.from('chino_keys').update(update).eq('id',id);if(error)throw error;}
      await refresh();showToast('Estado actualizado ✓','success');
    }catch(e){showToast(readableError(e),'error');renderAdmin();}
  }
  async function deleteKey(id){
    if(!state.isAdmin)return;
    const key=state.adminKeys.find(k=>k.id===id);
    if(!window.confirm(`¿Eliminar ${key?.plan||'esta key'} del inventario? La licencia externa NO se cancela.`))return;
    try{
      if(DEMO)demoSave(demoLoad().filter(k=>k.id!==id));
      else {const {error}=await client.from('chino_keys').delete().eq('id',id);if(error)throw error;}
      await refresh();showToast('Key eliminada del inventario.','success');
    }catch(e){showToast(readableError(e),'error');}
  }
  async function logout(){
    if(DEMO){demoSave(demoSeed());closeModal();await refresh();showToast('Demo restablecida ✓','success');return;}
    const {error}=await client.auth.signOut();if(error){showToast(readableError(error),'error');return;}
    closeModal();state.user=null;state.isAdmin=false;await refresh();showToast('Sesión cerrada.','success');
  }
  async function handleModalClick(e){
    const target=e.target.closest('button');if(!target)return;
    if(target.id==='logoutBtn'){logout();return;}
    if(target.dataset.confirmClaim){performClaim(target.dataset.confirmClaim,target);return;}
    if(target.id==='secretCopyBtn'){copyText($('#secretText')?.textContent||'');return;}
    if(target.id==='goMineBtn'){closeModal();openMine();}
  }
  async function handleModalSubmit(e){
    if(e.target.id==='addKeysForm'){e.preventDefault();await addKeys(e.target);return;}
    if(e.target.id==='loginForm'){
      e.preventDefault();const form=e.target;const email=form.elements.email.value.trim();
      const btn=form.querySelector('button');btn.disabled=true;btn.textContent='Enviando…';
      try{
        const redirect=window.location.origin+window.location.pathname;
        const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:redirect}});
        if(error)throw error;
        showModal(heading('// CHECK YOUR EMAIL','Revisa tu correo','Te enviamos un enlace para iniciar sesión. Ábrelo desde el mismo navegador para volver a esta página.')+'<p class="modal-note">Si no aparece, revisa Spam o Correo no deseado.</p>');
        showToast('Enlace enviado a '+email,'success');
      }catch(err){showToast(readableError(err),'error');btn.disabled=false;btn.textContent='Enviar enlace de acceso ↗';}
    }
  }
  window.addEventListener('DOMContentLoaded',init);
})();
