(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const cfg = window.CHINO_CONFIG || {};
  const delay = Math.max(10, Number(cfg.refreshSeconds) || 15) * 1000;
  const statusNames = {available:'AVAILABLE',full:'FULL',reserved:'RESERVED'};
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const short = (s) => String(s||'').replace(/-/g,'').slice(0,8).toUpperCase();
  const state = {client:null,user:null,role:null,inventory:[],owned:[],keys:[],approvals:[],filter:'all',busy:false,cycle:0,authMode:'login',toastTimer:null};
  let currentlyShown='bootView';

  function screen(id) {
    for (const s of ['bootView','setupView','loginView','pendingView','errorView','vaultView']) $(s).hidden=(s!==id);
    $('logoutBtn').hidden=!(id==='vaultView' || id==='pendingView');
    currentlyShown=id;
  }
  function toast(message,bad=false){
    const el=$('toast');clearTimeout(state.toastTimer);el.textContent=message;el.classList.toggle('bad',bad);el.hidden=false;
    state.toastTimer=setTimeout(()=>{el.hidden=true;},4400);
  }
  function friendly(e){
    const m=String(e?.message||e||'Error desconocido');
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed|email_not_confirmed/i.test(m)) return 'Debes confirmar tu correo primero. Revisa el mensaje de Supabase.';
    if (/rate limit|email rate limit/i.test(m)) return 'Se alcanzó el límite de correos. Configura SMTP propio en Supabase.';
    if (/Error sending confirmation email|Error sending magic link|email address not authorized|only send.*authorized/i.test(m)) return 'Supabase no puede enviar ese correo. Configura SMTP personalizado en Authentication → SMTP.';
    if (/ACCESS_DENIED/i.test(m)) return 'Esta cuenta no está autorizada.';
    if (/ALREADY_CLAIMED/i.test(m)) return 'Tu cuenta ya reclamó una key.';
    if (/NOT_AVAILABLE/i.test(m)) return 'Esta key ya no está disponible.';
    if (/duplicate key|unique constraint/i.test(m)) return 'Hay una key o un correo repetido.';
    if (/does not exist|could not find the function|schema cache|permission denied/i.test(m)) return 'Falta ejecutar V2_ACTUALIZACION.sql o revisar los permisos en Supabase.';
    return m;
  }
  function fail(e){console.error('[CHINO V2]',e);$('errorText').textContent=friendly(e);screen('errorView');}
  function setAuthMode(mode){
    state.authMode=mode;
    document.querySelectorAll('[data-auth-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.authMode===mode));
    $('passwordGroup').hidden=(mode==='magic');
    $('password').required=(mode!=='magic');
    $('password').autocomplete=mode==='register'?'new-password':'current-password';
    $('authHeading').textContent=mode==='login'?'Bienvenido.':mode==='register'?'Crear cuenta.':'Enlace privado.';
    $('authHelp').textContent=mode==='login'?'Accede con tu correo y contraseña.':mode==='register'?'Una cuenta no te da acceso automáticamente: el dueño debe autorizarte.':'Te enviamos un enlace para iniciar sesión en este navegador.';
    $('authSubmit').innerHTML=mode==='login'?'Iniciar sesión <span>→</span>':mode==='register'?'Crear cuenta <span>→</span>':'Enviar enlace <span>→</span>';
    $('authMessage').hidden=true;
  }
  function formMessage(message,bad=false){const e=$('authMessage');e.textContent=message;e.classList.toggle('bad',bad);e.hidden=false;}
  function sdk(){
    return new Promise((resolve,reject)=>{
      if(window.supabase?.createClient) return resolve();
      const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload=()=>window.supabase?.createClient?resolve():reject(new Error('Biblioteca Supabase no disponible'));
      s.onerror=()=>reject(new Error('No se pudo cargar la librería Supabase. Comprueba tu conexión.'));
      document.head.appendChild(s);
    });
  }
  async function init(){
    $('authForm').addEventListener('submit',signIn);
    document.querySelectorAll('[data-auth-mode]').forEach(b=>b.addEventListener('click',()=>setAuthMode(b.dataset.authMode)));
    $('logoutBtn').addEventListener('click',logout);
    $('pendingLogout').addEventListener('click',logout);
    $('checkApproval').addEventListener('click',gate);
    $('retryBtn').addEventListener('click',gate);
    $('refreshBtn').addEventListener('click',()=>gate(true));
    $('filters').addEventListener('click',(e)=>{const b=e.target.closest('[data-filter]');if(!b)return;state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));renderInventory();});
    $('inventory').addEventListener('click',(e)=>{const b=e.target.closest('[data-claim]');if(b)claim(b.dataset.claim);});
    $('ownedKeys').addEventListener('click',(e)=>{const b=e.target.closest('[data-copy]');if(b){const v=state.owned.find(k=>k.id===b.dataset.copy);if(v)copy(v.code);}});
    $('addKeysForm').addEventListener('submit',addKeys);
    $('approveForm').addEventListener('submit',approve);
    $('approvals').addEventListener('click',(e)=>{const b=e.target.closest('[data-revoke]');if(b)revoke(b.dataset.revoke);});
    $('adminKeys').addEventListener('click',(e)=>{const b=e.target.closest('[data-delete]');if(b)deleteKey(b.dataset.delete);});
    $('adminKeys').addEventListener('change',(e)=>{const b=e.target.closest('[data-status]');if(b)changeStatus(b.dataset.status,b.value);});
    $('closeDialog').addEventListener('click',closeDialog);
    $('dialog').addEventListener('click',(e)=>{if(e.target===$('dialog'))closeDialog();});
    document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeDialog();});
    $('dialogBody').addEventListener('click',(e)=>{const b=e.target.closest('[data-dialog-copy]');if(b)copy(b.dataset.dialogCopy);});

    if(!cfg.supabaseUrl?.startsWith('https://') || !/^((sb_publishable_)|(eyJ))/.test(cfg.supabaseAnonKey||'')){
      $('setupError').textContent='Falta una URL o una Publishable Key válida en config.js. La versión V2 nunca activa keys ficticias.';
      screen('setupView');return;
    }
    try{
      await sdk();
      state.client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      state.client.auth.onAuthStateChange((_event,session)=>{
        if((state.user?.id||null)!==(session?.user?.id||null))setTimeout(()=>gate(),0);
      });
      await gate();
      setInterval(()=>{if(!document.hidden && state.client && state.user)gate(true);},delay);
      document.addEventListener('visibilitychange',()=>{if(!document.hidden && state.user)gate(true);});
    }catch(e){fail(e);}
  }
  async function signIn(e){
    e.preventDefault();
    const email=$('email').value.trim().toLowerCase(),password=$('password').value,mode=state.authMode;
    const b=$('authSubmit');b.disabled=true;
    try{
      let error, data;
      if(mode==='magic'){
        ({error}=await state.client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}}));
        if(error)throw error;
        formMessage('Revisa tu correo y Spam. Abre el enlace recibido para volver al vault. Si no llega, debes configurar SMTP en Supabase.');
      }else if(mode==='register'){
        ({data,error}=await state.client.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}}));
        if(error)throw error;
        formMessage(data?.session?'Cuenta creada. Esperando autorización del dueño.':'Cuenta registrada. Confirma el mensaje que recibas por correo; después deberás esperar autorización del dueño.');
        if(data?.session)await gate();
      }else{
        ({error}=await state.client.auth.signInWithPassword({email,password}));
        if(error)throw error;
        await gate();
      }
    }catch(ex){formMessage(friendly(ex),true);}finally{b.disabled=false;}
  }
  async function gate(quiet=false){
    if(!state.client)return;
    if(state.busy)return;
    const cycle=++state.cycle;state.busy=true;
    if(!quiet)screen('bootView');
    try{
      // getUser valida la cuenta contra Supabase, no solo un objeto almacenado localmente.
      const {data:auth,error:authError}=await state.client.auth.getUser();
      if(authError && !/Auth session missing/i.test(authError.message))throw authError;
      if(cycle!==state.cycle)return;
      state.user=auth?.user||null;
      if(!state.user){state.role=null;state.inventory=[];state.owned=[];state.keys=[];state.approvals=[];screen('loginView');return;}
      const {data:role,error:roleError}=await state.client.rpc('chino_access_status');
      if(roleError)throw roleError;
      if(cycle!==state.cycle)return;
      state.role=role;
      if(role!=='admin'&&role!=='approved'){
        state.inventory=[];state.owned=[];state.keys=[];state.approvals=[];
        $('pendingEmail').textContent=state.user.email||'Cuenta sin correo';screen('pendingView');return;
      }
      const requests=[state.client.rpc('chino_inventory'),state.client.from('chino_keys').select('id,plan,code,status,created_at').eq('claimed_by',state.user.id).order('created_at',{ascending:false})];
      if(role==='admin'){
        requests.push(state.client.from('chino_keys').select('id,plan,code,status,claimed_by,created_at').order('created_at',{ascending:false}));
        requests.push(state.client.from('chino_allowed_emails').select('email,created_at').order('created_at',{ascending:false}));
      }
      const result=await Promise.all(requests);
      const problem=result.find(r=>r.error)?.error;if(problem)throw problem;
      if(cycle!==state.cycle)return;
      state.inventory=result[0].data||[];state.owned=result[1].data||[];
      state.keys=role==='admin'?(result[2].data||[]):[];
      state.approvals=role==='admin'?(result[3].data||[]):[];
      render();screen('vaultView');
      if(!quiet)window.scrollTo({top:0,behavior:'instant'});
    }catch(e){fail(e);}finally{state.busy=false;}
  }
  function render(){
    $('welcomeEmail').textContent=state.user?.email||'';
    $('rolePill').textContent=state.role==='admin'?'✦ OWNER':'● MIEMBRO';
    $('adminArea').hidden=(state.role!=='admin');
    const all=state.inventory;
    $('totalCount').textContent=all.length;
    $('availableCount').textContent=all.filter(k=>k.status==='available').length;
    $('fullCount').textContent=all.filter(k=>k.status==='full').length;
    $('reservedCount').textContent=all.filter(k=>k.status==='reserved').length;
    renderInventory();renderOwned();if(state.role==='admin')renderAdmin();
  }
  function renderInventory(){
    const list=state.inventory.filter(k=>state.filter==='all'||k.status===state.filter);
    $('inventory').innerHTML=list.length?list.map(k=>`<article class="key-card"><div class="key-top"><span class="key-token">⌁</span><span class="badge ${esc(k.status)}">● ${statusNames[k.status]||'KEY'}</span></div><div><h3>${esc(k.plan)}</h3><p>KEY ID · ${esc(short(k.id))}</p></div><button type="button" class="key-btn" data-claim="${esc(k.id)}" ${k.status!=='available'?'disabled':''}>${k.status==='available'?'Reclamar key →':'No disponible'}</button></article>`).join(''):'<div class="empty">No hay keys en esta categoría.</div>';
  }
  function renderOwned(){
    $('ownedKeys').innerHTML=state.owned.length?state.owned.map(k=>`<article class="key-card"><div class="key-top"><span class="key-token">✦</span><span class="badge full">● TU KEY</span></div><div><h3>${esc(k.plan)}</h3><div class="key-code">${esc(k.code)}</div></div><button class="key-btn" data-copy="${esc(k.id)}" type="button">Copiar código ↗</button></article>`).join(''):'<div class="empty">Todavía no has reclamado ninguna key.</div>';
  }
  function renderAdmin(){
    $('approvals').innerHTML=state.approvals.length?state.approvals.map(a=>`<div class="approval-item"><span>${esc(a.email)}</span><button type="button" class="outline-danger" data-revoke="${esc(a.email)}">Quitar</button></div>`).join(''):'<div class="hint">No has aprobado correos todavía. Tu cuenta OWNER siempre tiene acceso.</div>';
    $('adminTotal').textContent=state.keys.length+' KEYS';
    $('adminKeys').innerHTML=state.keys.length?state.keys.map(k=>`<div class="admin-row"><div><strong>${esc(k.plan)} <span class="badge ${esc(k.status)}">${statusNames[k.status]}</span></strong><small>${esc(k.code)} ${k.claimed_by?'· RECLAMADA':''}</small></div><select data-status="${esc(k.id)}" aria-label="Estado de ${esc(k.plan)}"><option value="available" ${k.status==='available'?'selected':''}>Available</option><option value="reserved" ${k.status==='reserved'?'selected':''}>Reserved</option><option value="full" ${k.status==='full'?'selected':''}>Full</option></select><button class="outline-danger" type="button" data-delete="${esc(k.id)}">Eliminar</button></div>`).join(''):'<div class="empty">Sin keys. Agrega la primera arriba.</div>';
  }
  async function claim(id){
    if(state.role!=='admin'&&state.role!=='approved')return;
    const key=state.inventory.find(k=>k.id===id);
    if(!key||key.status!=='available')return toast('Esta key no está disponible.',true);
    if(!confirm(`¿Reclamar ${key.plan}? Solo se permite una key por cuenta.`))return;
    try{
      const {data,error}=await state.client.rpc('chino_claim',{p_key_id:id});
      if(error)throw error;
      const selected=data?.[0];if(!selected)throw Error('NOT_AVAILABLE');
      await gate(true);
      openDialog(`<span class="overline">CLAIM SUCCESSFUL</span><h2>¡Esta key es tuya!</h2><p>Se ha marcado FULL para los demás usuarios.</p><div class="secret">${esc(selected.code)}</div><button type="button" class="btn primary" data-dialog-copy="${esc(selected.code)}">Copiar key →</button>`);
    }catch(e){toast(friendly(e),true);await gate(true);}
  }
  async function copy(s){
    try{await navigator.clipboard.writeText(s);toast('Key copiada ✓');}
    catch(e){toast('Copia manualmente el código que aparece en pantalla.',true);}
  }
  function openDialog(html){$('dialogBody').innerHTML=html;$('dialog').hidden=false;}
  function closeDialog(){$('dialog').hidden=true;$('dialogBody').innerHTML='';}
  async function addKeys(e){
    e.preventDefault();if(state.role!=='admin')return;
    const f=e.currentTarget,plan=f.elements.plan.value.trim(),raw=f.elements.codes.value;
    const codes=[...new Set(raw.split(/\r?\n/g).map(s=>s.trim()).filter(Boolean))];
    if(!plan||!codes.length||codes.length>50||codes.some(s=>s.length>300)){toast('Agrega entre 1 y 50 keys válidas (máximo 300 caracteres cada una).',true);return;}
    const button=f.querySelector('button[type="submit"]');button.disabled=true;
    try{
      const {error}=await state.client.from('chino_keys').insert(codes.map(code=>({plan,code,status:'available'})));
      if(error)throw error;
      f.reset();toast(codes.length+' keys agregadas ✓');await gate(true);
    }catch(err){toast(friendly(err),true);}finally{button.disabled=false;}
  }
  async function approve(e){
    e.preventDefault();if(state.role!=='admin')return;
    const f=e.currentTarget,email=f.elements.email.value.trim().toLowerCase();
    if(!email||email.length>254)return;
    const b=f.querySelector('button[type="submit"]');b.disabled=true;
    try{
      const {error}=await state.client.from('chino_allowed_emails').insert({email});
      if(error)throw error;
      f.reset();toast('Correo autorizado ✓');await gate(true);
    }catch(err){toast(friendly(err),true);}finally{b.disabled=false;}
  }
  async function revoke(email){
    if(state.role!=='admin'||!confirm('¿Quitar el acceso a '+email+'? Dejará de poder consultar y reclamar keys.'))return;
    try{const {error}=await state.client.from('chino_allowed_emails').delete().eq('email',email);if(error)throw error;toast('Acceso retirado ✓');await gate(true);}catch(e){toast(friendly(e),true);}
  }
  async function changeStatus(id,status){
    if(state.role!=='admin'||!statusNames[status])return;
    const k=state.keys.find(x=>x.id===id);if(!k||k.status===status)return;
    if(k.claimed_by && status!=='full' && !confirm('Esta key ya fue reclamada. Al liberarla, el usuario perderá acceso a este código en la web; la licencia externa NO se revoca. ¿Continuar?')){renderAdmin();return;}
    try{
      const patch={status};if(status!=='full'){patch.claimed_by=null;patch.claimed_at=null;}
      const {error}=await state.client.from('chino_keys').update(patch).eq('id',id);if(error)throw error;
      toast('Estado actualizado ✓');await gate(true);
    }catch(e){toast(friendly(e),true);renderAdmin();}
  }
  async function deleteKey(id){
    if(state.role!=='admin'||!confirm('¿Eliminar esta key del inventario? No cancela una licencia externa.'))return;
    try{const {error}=await state.client.from('chino_keys').delete().eq('id',id);if(error)throw error;toast('Key eliminada ✓');await gate(true);}catch(e){toast(friendly(e),true);}
  }
  async function logout(){
    if(!state.client)return;
    try{const {error}=await state.client.auth.signOut();if(error)throw error;state.user=null;state.role=null;state.inventory=[];state.owned=[];state.keys=[];state.approvals=[];screen('loginView');toast('Sesión cerrada.');}catch(e){toast(friendly(e),true);}
  }
  window.addEventListener('DOMContentLoaded',init);
})();
