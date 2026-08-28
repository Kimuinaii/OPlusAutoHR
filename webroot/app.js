import { exec, toast, enableEdgeToEdge, hasKsu } from "./ksu.js";
enableEdgeToEdge(true);

const $ = id => document.getElementById(id);
let snackTimer=null, allModes=[], current=null, busy=false;
let selectionDirty=false, selectedRes=null, selectedHz=null;
let previewTimer=null, previewToken=null, previewSeconds=0, previewBusy=false;
let modesPhysicalId=null, refreshInFlight=false, interactionHoldUntil=0, engineRestartBusy=false;
let lastDebugPaint=0, pollTimer=null;
let appStarted=false, agreementSessionAccepted=false;
const AGREEMENT_VERSION="canary-1.0-20260828";
const AGREEMENT_STORAGE_KEY="oah_agreement_version";

function snack(msg){
  $("snack").textContent=msg;
  $("snack").classList.add("show");
  clearTimeout(snackTimer);
  snackTimer=setTimeout(()=>$("snack").classList.remove("show"),2400);
  toast(msg);
}
function cmd(args){return `sh /data/adb/modules/oplusautohr.v2/bin/oahctl ${args}`;}
async function run(args){
  const r=await exec(cmd(args));
  const t=(r.stdout||"").trim();
  if(!t)throw new Error(r.stderr||`shell errno=${r.errno}`);
  let x; try{x=JSON.parse(t)}catch(_){throw new Error(`JSON parse failed: ${t.slice(0,600)}`)}
  if(x.ok===false){const e=new Error(x.message||"操作失败");e.data=x;throw e;}
  return x;
}
function fmtHz(v){
  const n=Number(v); if(!Number.isFinite(n))return "—";
  const r=Math.round(n); return Math.abs(n-r)<.08?String(r):n.toFixed(2);
}
function modeText(m){
  if(!m)return "—";
  return `${m.width}×${m.height} @ ${fmtHz(m.refresh)}Hz`;
}
function updateEngineUi(s){
  const eng=s?.engine||{};
  const state=$("engineState");
  const row=$("engineRecoveryRow");
  const btn=$("restartEngineBtn");
  const hint=$("engineRecoveryHint");

  state.textContent = eng.ready
    ? `引擎在线 · DMC ${eng.dmcReady?"Ready":"Waiting"}`
    : `引擎离线${eng.lastError && eng.lastError!=="-" ? ` · ${eng.lastError}`:""}`;

  row.hidden=!!eng.ready;
  btn.disabled=!!eng.ready || engineRestartBusy;
  if(!eng.ready){
    if(eng.injectorPresent===false){
      hint.textContent="未找到 fij1673。请确认 Canary 已从 V1 导入 HWC injector。";
    }else if(eng.lastError && eng.lastError!=="-"){
      hint.textContent=`${eng.lastError} · 可尝试重新注入控制引擎，不会主动重启 SurfaceFlinger。`;
    }else{
      hint.textContent="可尝试重新注入控制引擎，不会主动重启 SurfaceFlinger。";
    }
  }
}

function updateInternalMaxUi(s){
  const im=s?.internalMax||{};
  const sw=$("internalMaxSwitch");
  const tag=$("internalMaxTag");
  const meta=$("internalMaxMeta");
  if(!sw||!tag||!meta)return;

  sw.disabled=false;
  sw.classList.toggle("on",im.enabled===true);
  sw.dataset.on=im.enabled?"1":"0";

  if(im.recommended){
    tag.textContent="Xiaomi 默认开启";
    tag.classList.remove("neutral");
  }else{
    tag.textContent="其他设备默认关闭";
    tag.classList.add("neutral");
  }

  if(im.lastApplied && im.refresh && im.resolution){
    meta.textContent=`已锁定内屏 ${im.resolution} @ ${fmtHz(im.refresh)}Hz · 关闭开关只停止后续自动触发，当前锁定保留到重启。`;
  }else if(im.enabled){
    meta.textContent="外屏连接时自动扫描内屏真实模式，并锁定原生分辨率组的最高刷新率；Xiaomi / HyperOS 推荐开启。";
  }else{
    meta.textContent="已关闭自动触发。若本次开机已执行过锁定，当前刷新率会保持到重启。";
  }
}

function setDisconnected(){
  $("dot").classList.remove("on");$("connectionText").textContent="未检测到外接物理显示器";
  $("displayName").textContent="External Display";$("displaySub").textContent="连接 USB-C / DisplayPort 后自动刷新";
  ["heroHz","heroRes","heroLogical","heroHwc","heroPhysical"].forEach(id=>$(id).textContent="—");
  $("applyBtn").disabled=true;
}
function paintDebug(value, force=false){
  const details=document.querySelector("details.debug");
  if(!force && !details?.open)return;
  const now=Date.now();
  if(!force && now-lastDebugPaint<2200)return;
  lastDebugPaint=now;
  $("debugText").textContent=typeof value==="string"?value:JSON.stringify(value,null,2);
}

function updateStatus(s){
  current=s;paintDebug(s,false);
  updateEngineUi(s);
  updateInternalMaxUi(s);
  if(!s.connected){setDisconnected();return;}
  $("dot").classList.add("on");$("connectionText").textContent="外接显示器已连接";
  $("displayName").textContent=s.name||"External Display";
  $("displaySub").textContent=[s.pnpId,s.port?`Port ${s.port}`:null].filter(Boolean).join(" · ");

  const actual=s.actual||{}, sf=s.sf||{};
  const useActual=actual.resolution && actual.resolution!=="unknown" && actual.refresh!=="unknown";
  $("heroHz").textContent=useActual?fmtHz(actual.refresh):fmtHz(sf.refresh);
  $("heroRes").textContent=useActual?actual.resolution:(sf.resolution||"—");
  $("heroLogical").textContent=s.logicalId??"—";$("heroHwc").textContent=s.hwcId??"—";$("heroPhysical").textContent=s.physicalId||"—";

  $("linkEstimate").textContent=s.linkEstimate||"—";$("pnpId").textContent=s.pnpId||"—";$("portId").textContent=s.port||"—";

  const sync=$("syncState");
  if(s.synced){
    sync.textContent=`已同步 · ${fmtHz(actual.refresh)} Hz`;
    sync.className="state good";
  }else if(useActual){
    sync.textContent=`HWC ${fmtHz(actual.refresh)} / SF ${fmtHz(sf.refresh)} · 未同步`;
    sync.className="state bad";
  }else{
    sync.textContent="等待 HWC 引擎";
    sync.className="state neutral";
  }

  const eng=s.engine||{};

  $("autoSwitch").disabled=false;
  $("autoSwitch").classList.toggle("on",!!s.autoEnabled);
  $("autoSwitch").dataset.on=s.autoEnabled?"1":"0";

  const pace=s.pacesetter||{};
  $("monitorHwc").textContent=useActual ? `${actual.resolution} @ ${fmtHz(actual.refresh)}Hz` : "—";
  $("monitorSf").textContent=sf.resolution && sf.resolution!=="unknown" ? `${sf.resolution} @ ${fmtHz(sf.refresh)}Hz` : "—";
  $("monitorPaceRole").textContent=pace.role==="external" ? "External · 外屏" : pace.role==="internal" ? "Internal · 内屏" : "Unknown";
  $("monitorPaceRate").textContent=pace.renderRate && pace.renderRate!=="unknown" ? `${fmtHz(pace.renderRate)} Hz` : (pace.refresh&&pace.refresh!=="unknown"?`${fmtHz(pace.refresh)} Hz`:"—");
  $("monitorPacePhys").textContent=pace.physicalId||"—";
  $("paceSwitch").disabled=!eng.schedulerReady || !s.connected || previewBusy;
  $("paceSwitch").classList.toggle("on",pace.external===true);
  $("paceSwitch").dataset.on=pace.external?"1":"0";
  $("paceHint").textContent=eng.schedulerReady
    ? (pace.external ? "外屏正在作为调度基准 · 实验模式已启用" : "当前使用系统默认内屏调度基准")
    : "Scheduler Waiting · 等待捕获调度器对象";
}

function uniqueRes(){
  const m=new Map();
  for(const x of allModes){
    const k=`${x.width}x${x.height}`;
    if(!m.has(k))m.set(k,{key:k,width:x.width,height:x.height});
  }
  return [...m.values()].sort((a,b)=>(b.width*b.height)-(a.width*a.height));
}

function populateRes(){
  const rs=uniqueRes();
  const sel=$("resolutionSelect");
  sel.innerHTML=rs.map(r=>`<option value="${r.key}">${r.width} × ${r.height}</option>`).join("");

  const actualRes=current?.actual?.resolution!=="unknown" ? current?.actual?.resolution : current?.sf?.resolution;
  let wanted = selectionDirty && selectedRes ? selectedRes : actualRes;
  if(!wanted || !rs.some(r=>r.key===wanted)) wanted=rs[0]?.key;

  if(wanted)sel.value=wanted;
  sel.disabled=!rs.length;
  populateHz();
}

function populateHz(){
  const res=$("resolutionSelect").value;
  const rates=allModes.filter(m=>`${m.width}x${m.height}`===res).sort((a,b)=>b.refresh-a.refresh);
  const sel=$("refreshSelect");
  sel.innerHTML=rates.map(m=>`<option value="${m.refresh}">${fmtHz(m.refresh)} Hz</option>`).join("");

  let picked=null;
  if(selectionDirty && selectedRes===res && selectedHz!==null){
    picked=rates.find(m=>Math.abs(Number(m.refresh)-Number(selectedHz))<.2);
  }
  if(!picked && !selectionDirty){
    const cur=Number(current?.actual?.refresh);
    if(Number.isFinite(cur))picked=rates.find(m=>Math.abs(m.refresh-cur)<.2);
  }
  if(picked)sel.value=String(picked.refresh);

  // When the user has just chosen a new resolution, default to that resolution's
  // highest enumerated rate, but keep it stable across background refreshes.
  if(selectionDirty && selectedRes===res && selectedHz===null && rates.length){
    sel.value=String(rates[0].refresh);
    selectedHz=sel.value;
  }

  sel.disabled=!rates.length;
  $("applyBtn").disabled=!rates.length||busy||previewBusy;
}

async function loadModes(physicalId=null){
  const m=await run("modes");
  allModes=m.modes||[];
  modesPhysicalId=physicalId||current?.physicalId||null;
  populateRes();
  $("alphaBadge").textContent=`${allModes.length} modes`;
}

async function refresh(silent=false,forceModes=false){
  if(refreshInFlight || busy)return;
  refreshInFlight=true;
  $("refreshBtn").disabled=true;
  try{
    if(!hasKsu())throw new Error("请从 KernelSU / SukiSU 的模块 WebUI 打开");
    const s=await run("status");
    updateStatus(s);
    if(s.connected && (forceModes || !allModes.length || modesPhysicalId!==s.physicalId)){
      await loadModes(s.physicalId);
    }
  }catch(e){
    $("debugText").textContent=String(e?.stack||e);
    if(!silent)snack(e.message||"读取失败");
  }finally{
    refreshInFlight=false;
    $("refreshBtn").disabled=false;
  }
}

function setApplyBusy(on){
  const b=$("applyBtn");
  busy=on;
  if(on){
    b.classList.add("busy");
    b.disabled=true;
    b.innerHTML='<span class="btn-spinner"></span><span>正在切换并同步…</span>';
  }else{
    b.classList.remove("busy");
    b.innerHTML='应用显示模式';
    b.disabled=previewBusy || !$("refreshSelect").value;
  }
}

function closePreviewDialog(){
  clearInterval(previewTimer); previewTimer=null;
  previewToken=null; previewSeconds=0; previewBusy=false;
  $("modeConfirmBackdrop").hidden=true;
  document.body.classList.remove("modal-open");
  $("applyBtn").disabled=false;
}

async function confirmPreview(){
  if(!previewToken || previewBusy===false)return;
  const token=previewToken;
  $("keepModeBtn").disabled=true;
  $("revertModeBtn").disabled=true;
  try{
    const r=await run(`confirm ${token}`);
    $("debugText").textContent=JSON.stringify(r,null,2);
    closePreviewDialog();
    selectionDirty=false; selectedRes=null; selectedHz=null;
    snack(r.confirmed===false ? "倒计时已结束，显示模式已处理" : "已保留显示设置");
    await refresh(true);
  }catch(e){
    snack(e.message||"确认失败");
    $("keepModeBtn").disabled=false;
    $("revertModeBtn").disabled=false;
  }
}

async function revertPreview(auto=false){
  if(!previewToken || previewBusy===false)return;
  const token=previewToken;
  clearInterval(previewTimer); previewTimer=null;
  $("keepModeBtn").disabled=true;
  $("revertModeBtn").disabled=true;
  $("modeConfirmTitle").textContent=auto?"正在自动还原…":"正在还原…";
  $("modeCountdown").textContent="0"; $("keepCountdown").textContent="0";
  try{
    const r=await run(`revert ${token}`);
    $("debugText").textContent=JSON.stringify(r,null,2);
    closePreviewDialog();
    selectionDirty=false; selectedRes=null; selectedHz=null;
    snack(auto?"已自动还原显示设置":"已还原显示设置");
    await refresh(true);
  }catch(e){
    // Backend watchdog remains active even if this foreground request fails.
    snack("前台还原请求失败，后台安全计时器仍会执行");
    setTimeout(()=>{ closePreviewDialog(); refresh(true); },1000);
  }
}

function showPreviewDialog(preview){
  if(!preview?.token)return;
  clearInterval(previewTimer);
  previewToken=preview.token;
  previewSeconds=Number(preview.seconds)||10;
  previewBusy=true;

  $("previousModeText").textContent=modeText(preview.previous);
  $("currentModeText").textContent=modeText(preview.current);
  $("modeConfirmTitle").textContent="保留这些显示设置吗？";
  $("modeCountdown").textContent=String(previewSeconds);
  $("keepCountdown").textContent=String(previewSeconds);
  $("keepModeBtn").disabled=false;
  $("revertModeBtn").disabled=false;
  $("modeConfirmBackdrop").hidden=false;
  document.body.classList.add("modal-open");
  $("applyBtn").disabled=true;

  previewTimer=setInterval(()=>{
    previewSeconds--;
    $("modeCountdown").textContent=String(Math.max(previewSeconds,0));
    $("keepCountdown").textContent=String(Math.max(previewSeconds,0));
    if(previewSeconds<=0){
      clearInterval(previewTimer);previewTimer=null;
      revertPreview(true);
    }
  },1000);
}

$("resolutionSelect").addEventListener("change",()=>{
  selectionDirty=true;
  selectedRes=$("resolutionSelect").value;
  selectedHz=null;
  populateHz();
});
$("refreshSelect").addEventListener("change",()=>{
  selectionDirty=true;
  selectedRes=$("resolutionSelect").value;
  selectedHz=$("refreshSelect").value;
});
$("refreshBtn").addEventListener("click",()=>refresh(false,true));

function holdBackgroundRefresh(ms=1400){
  interactionHoldUntil=Math.max(interactionHoldUntil,Date.now()+ms);
}
function optimisticAppliedMode(w,h,hz){
  $("heroRes").textContent=`${w}x${h}`;
  $("heroHz").textContent=fmtHz(hz);
  const sync=$("syncState");
  sync.textContent=`HWC ${fmtHz(hz)} / SF 同步中`;
  sync.className="state neutral";
}
document.addEventListener("pointerdown",()=>holdBackgroundRefresh(1400),{passive:true});

$("applyBtn").addEventListener("pointerdown",()=>{
  if(!$("applyBtn").disabled)$("applyBtn").classList.add("pressed");
});
["pointerup","pointercancel","pointerleave"].forEach(ev=>{
  $("applyBtn").addEventListener(ev,()=>setTimeout(()=>$("applyBtn").classList.remove("pressed"),90));
});

$("applyBtn").addEventListener("click",async()=>{
  const res=$("resolutionSelect").value,hz=$("refreshSelect").value,[w,h]=res.split("x");
  if(!w||!h||!hz||previewBusy)return;

  if(navigator.vibrate)try{navigator.vibrate(12)}catch(_){}
  setApplyBusy(true);

  try{
    const r=await run(`apply ${w} ${h} ${hz}`);
    $("debugText").textContent=JSON.stringify(r,null,2);

    // From this point the selection is now the applied state, so normal
    // background refreshes may follow it again.
    selectionDirty=false; selectedRes=null; selectedHz=null;

    if(String(r.hwcOk)!=="1"){
      // Do one delayed reconciliation before showing failure. This also updates
      // the hero card if the vendor state arrived just after the backend timeout.
      await new Promise(resolve=>setTimeout(resolve,550));
      await refresh(true);
      const aw=Number(current?.actual?.refresh);
      const actualMatch=current?.actual?.resolution===`${w}x${h}` && Number.isFinite(aw) && Math.abs(aw-Number(hz))<.25;
      if(!actualMatch){
        snack(`HWC 切换失败${r.error && r.error!=="-" ? ` · ${r.error}` : ""}`);
        return;
      }
      snack("HWC 已生效 · 正在补同步状态");
      try{await run("sync")}catch(_){}
    }

    optimisticAppliedMode(w,h,hz);
    // Confirmation is safety-critical, so show it immediately; status polling can
    // finish in the background instead of delaying the dialog/UI.
    if(r.preview)showPreviewDialog(r.preview);
    else snack(`显示模式已应用 ${w}×${h} @ ${fmtHz(hz)}Hz`);
    refresh(true);
  }catch(e){
    $("debugText").textContent=JSON.stringify(e.data||{error:e.message},null,2);
    snack(e.message||"切换失败");
  }finally{
    setApplyBusy(false);
    if(previewBusy)$("applyBtn").disabled=true;
  }
});

$("keepModeBtn").addEventListener("click",confirmPreview);
$("revertModeBtn").addEventListener("click",()=>revertPreview(false));

$("autoSwitch").addEventListener("click",async()=>{
  if($("autoSwitch").disabled||previewBusy)return;
  const on=$("autoSwitch").dataset.on==="1";
  $("autoSwitch").disabled=true;
  try{
    const r=await run(`auto ${on?0:1}`);
    selectionDirty=false;selectedRes=null;selectedHz=null;
    if(!on && r.applied && r.result?.requested){
      const q=r.result.requested;
      snack(`自动最高：${q.width}×${q.height} @ ${fmtHz(q.refresh)}Hz`);
    }else snack(on?"已关闭自动最高刷新率":"已开启自动最高刷新率");
    setTimeout(()=>refresh(true),550);
  }catch(e){snack(e.message||"设置失败");}
  finally{setTimeout(()=>{$("autoSwitch").disabled=false},650);}
});


$("internalMaxSwitch").addEventListener("click",async()=>{
  if($("internalMaxSwitch").disabled||previewBusy)return;
  const on=$("internalMaxSwitch").dataset.on==="1";
  $("internalMaxSwitch").disabled=true;
  try{
    const r=await run(`internal-max ${on?0:1}`);
    $("debugText").textContent=JSON.stringify(r,null,2);
    if(on){
      snack("已关闭 HyperOS 自动高刷修复 · 当前锁定保留到重启");
    }else if(r.applied){
      snack(`HyperOS 修复已开启 · 内屏 ${r.resolution} @ ${fmtHz(r.refresh)}Hz`);
    }else{
      snack("HyperOS 修复已开启 · 接入外屏后自动生效");
    }
    await refresh(true);
  }catch(e){
    snack(e.message||"HyperOS 修复设置失败");
  }finally{
    $("internalMaxSwitch").disabled=false;
  }
});


function showPaceWarning(){
  $("paceWarnBackdrop").hidden=false;
  document.body.classList.add("modal-open");
}
function closePaceWarning(){
  $("paceWarnBackdrop").hidden=true;
  if($("modeConfirmBackdrop").hidden)document.body.classList.remove("modal-open");
}
async function setExternalPacesetter(enable){
  $("paceSwitch").disabled=true;
  try{
    const r=await run(`pace ${enable?"external":"internal"}`);
    $("debugText").textContent=JSON.stringify(r,null,2);
    if(enable){
      if(r.pacesetter?.external) snack("External pacesetter 已启用");
      else if(r.engine?.schedulerReady) snack("Pacesetter 请求已执行，但实际状态尚未验证");
      else snack("Scheduler Waiting，已保存请求");
    }else{
      snack("已恢复 Internal pacesetter");
    }
    await refresh(true);
  }catch(e){
    snack(e.message||"Pacesetter 切换失败");
  }finally{
    $("paceSwitch").disabled=false;
  }
}

$("paceSwitch").addEventListener("click",()=>{
  if($("paceSwitch").disabled||previewBusy)return;
  const on=$("paceSwitch").dataset.on==="1";
  if(on) setExternalPacesetter(false);
  else showPaceWarning();
});
$("cancelPaceBtn").addEventListener("click",closePaceWarning);
$("enablePaceBtn").addEventListener("click",async()=>{
  closePaceWarning();
  await setExternalPacesetter(true);
});

$("syncBtn").addEventListener("click",async()=>{
  if(previewBusy)return;
  $("syncBtn").disabled=true;
  try{
    const r=await run("sync");$("debugText").textContent=JSON.stringify(r,null,2);
    snack(r.synced?"已同步到实际 HWC 模式":"已发送同步请求");
    await refresh(true);
  }catch(e){snack(e.message||"同步失败");}
  finally{$("syncBtn").disabled=false;}
});

$("restartEngineBtn").addEventListener("click",async()=>{
  if(engineRestartBusy)return;
  engineRestartBusy=true;
  const b=$("restartEngineBtn");
  b.disabled=true;
  b.classList.add("busy");
  b.textContent="正在重启 HWC 控制引擎…";
  try{
    const r=await run("engine-restart");
    $("debugText").textContent=JSON.stringify(r,null,2);
    const st=r.status||{};
    if(r.ready || st.engine?.ready){
      snack("HWC 控制引擎已重新上线");
      updateStatus(st);
      if(st.connected) await loadModes(st.physicalId);
    }else if(r.injectorPresent===false || st.engine?.injectorPresent===false){
      snack("重启失败 · 未找到 fij1673");
    }else{
      snack("已发送重启请求 · 引擎仍未上线");
    }
  }catch(e){
    $("debugText").textContent=JSON.stringify(e.data||{error:e.message},null,2);
    snack(e.message||"HWC 控制引擎重启失败");
  }finally{
    engineRestartBusy=false;
    b.classList.remove("busy");
    b.textContent="尝试重启 HWC 控制引擎";
    await refresh(true);
  }
});

$("rawBtn").addEventListener("click",async()=>{
  try{const r=await run("raw");$("debugText").textContent=JSON.stringify(r,null,2);snack("诊断状态已刷新");}
  catch(e){$("debugText").textContent=String(e?.stack||e);snack("读取失败");}
});

document.querySelector("details.debug")?.addEventListener("toggle",e=>{
  if(e.currentTarget.open && current)paintDebug(current,true);
});

async function pollLoop(){
  clearTimeout(pollTimer);
  if(!appStarted)return;
  if(!document.hidden && !busy && !previewBusy && Date.now()>interactionHoldUntil){
    await refresh(true);
  }
  pollTimer=setTimeout(pollLoop,2500);
}

document.addEventListener("visibilitychange",()=>{
  if(!appStarted)return;
  if(!document.hidden){
    holdBackgroundRefresh(250);
    clearTimeout(pollTimer);
    pollTimer=setTimeout(pollLoop,300);
  }
});


function agreementAccepted(){
  if(agreementSessionAccepted)return true;
  try{return localStorage.getItem(AGREEMENT_STORAGE_KEY)===AGREEMENT_VERSION}catch(_){return false}
}
function persistAgreement(){
  agreementSessionAccepted=true;
  try{localStorage.setItem(AGREEMENT_STORAGE_KEY,AGREEMENT_VERSION)}catch(_){}
}
function updateAgreementAcceptState(){
  const ok=$('agreeTermsCheck').checked && $('agreeRiskCheck').checked;
  $('acceptAgreementBtn').disabled=!ok;
  if(ok)$('agreementDeclinedHint').hidden=true;
}
function showAgreement(review=false){
  const backdrop=$('agreementBackdrop');
  backdrop.hidden=false;
  document.body.classList.remove('agreement-pending');
  document.body.classList.add('agreement-active');
  $('agreementBody').scrollTop=0;
  $('agreementDeclinedHint').hidden=true;
  $('agreementChecks').hidden=review;
  $('agreementFirstActions').hidden=review;
  $('agreementReviewActions').hidden=!review;
  if(!review){
    $('agreeTermsCheck').checked=false;
    $('agreeRiskCheck').checked=false;
    updateAgreementAcceptState();
  }
}
function hideAgreement(){
  $('agreementBackdrop').hidden=true;
  document.body.classList.remove('agreement-active','agreement-pending');
}
function startApp(){
  if(appStarted)return;
  appStarted=true;
  hideAgreement();
  refresh().finally(()=>{ pollTimer=setTimeout(pollLoop,2500); });
}

$('agreeTermsCheck').addEventListener('change',updateAgreementAcceptState);
$('agreeRiskCheck').addEventListener('change',updateAgreementAcceptState);
$('acceptAgreementBtn').addEventListener('click',()=>{
  if($('acceptAgreementBtn').disabled)return;
  persistAgreement();
  startApp();
  snack('协议已确认 · 欢迎使用 OPlusAutoHR Canary');
});
$('declineAgreementBtn').addEventListener('click',()=>{
  agreementSessionAccepted=false;
  try{localStorage.removeItem(AGREEMENT_STORAGE_KEY)}catch(_){}
  $('agreementDeclinedHint').hidden=false;
  $('agreeTermsCheck').checked=false;
  $('agreeRiskCheck').checked=false;
  updateAgreementAcceptState();
});
$('openAgreementBtn').addEventListener('click',()=>showAgreement(true));
$('closeAgreementBtn').addEventListener('click',()=>{
  if(agreementAccepted())hideAgreement();
});

if(agreementAccepted())startApp();
else showAgreement(false);

