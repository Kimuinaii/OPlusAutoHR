'use strict';

const TAG = '[OAH-V2-A3.6]';

function log(s){ console.log(TAG + ' ' + s); }
function warn(s){ console.warn(TAG + ' ' + s); }

function propApi() {
  const getAddr = Module.findGlobalExportByName('__system_property_get');
  if (!getAddr) throw new Error('__system_property_get missing');
  const get = new NativeFunction(getAddr, 'int', ['pointer','pointer']);
  return {
    get(name) {
      const k = Memory.allocUtf8String(name);
      const out = Memory.alloc(256);
      out.writeByteArray(new Uint8Array(256));
      const n = get(k, out);
      return n > 0 ? out.readUtf8String() : '';
    }
  };
}
const PROP = propApi();

const P = {
  seq:'debug.oah.seq',
  action:'debug.oah.action',
  phys:'debug.oah.phys',
  hwc:'debug.oah.hwc',
  sfmode:'debug.oah.sfmode',
  config:'debug.oah.config',
  width:'debug.oah.width',
  height:'debug.oah.height',
  refresh:'debug.oah.refresh',
  period:'debug.oah.period',
  pacephys:'debug.oah.pacephys',
  paceenabled:'debug.oah.pace_enabled',
  internalphys:'debug.oah.internalphys'
};

const ATTR = { WIDTH:1, HEIGHT:2, VSYNC_PERIOD:3, CONFIG_GROUP:7 };
const INVALID = -2147483647;

function pnum(name, fallback=0) {
  const v = Number(PROP.get(name));
  return Number.isFinite(v) ? v : fallback;
}
function pstr(name) { return PROP.get(name); }
function canon(v) {
  try { return new UInt64(v.toString()).toString(16); } catch (_) { return null; }
}
function displayArg(key) { return new Int64('0x' + key); }
function hz(period) { return period > 0 ? 1000000000.0 / period : 0; }

const S = {
  engine:0, composer:0, dmc:0, scheduler:0,
  phys:'', hwc:'', actualConfig:'', width:'', height:'', refresh:'', period:'',
  lastSeq:'', lastAction:'', lastHwc:'', lastDmc:'', lastPace:'', lastError:''
};

function stateLine() {
  console.log(
    '[OAH-STATE]' +
    ' engine=' + S.engine +
    ' composer=' + S.composer +
    ' dmc=' + S.dmc +
    ' scheduler=' + S.scheduler +
    ' phys=' + (S.phys || '-') +
    ' hwc=' + (S.hwc || '-') +
    ' actualConfig=' + (S.actualConfig === '' ? '-' : S.actualConfig) +
    ' width=' + (S.width || '-') +
    ' height=' + (S.height || '-') +
    ' refresh=' + (S.refresh || '-') +
    ' period=' + (S.period || '-') +
    ' seq=' + (S.lastSeq || '-') +
    ' action=' + (S.lastAction || '-') +
    ' hwcOk=' + (S.lastHwc === '' ? '-' : S.lastHwc) +
    ' dmcOk=' + (S.lastDmc === '' ? '-' : S.lastDmc) +
    ' paceOk=' + (S.lastPace === '' ? '-' : S.lastPace) +
    ' error=' + (S.lastError ? String(S.lastError).replace(/\s+/g,'_') : '-')
  );
}

function findComposerModule() {
  let m = Process.enumerateModules().find(x =>
    x.name.indexOf('android.hardware.graphics.composer3-') >= 0 &&
    x.name.endsWith('-ndk.so'));
  if (!m) m = Process.enumerateModules().find(x =>
    x.name.indexOf('graphics.composer3') >= 0 && x.name.endsWith('.so'));
  return m || null;
}
function methodExport(module, methodName) {
  const list = module.enumerateExports().filter(e =>
    e.type === 'function' &&
    e.name.indexOf('BpComposerClient') >= 0 &&
    e.name.indexOf(methodName) >= 0);
  list.sort((a,b)=>a.name.length-b.name.length);
  return list.length ? list[0] : null;
}

let clientThis=null;
const addr={}, fn={};

function rememberThis(p) {
  if(!p || p.isNull()) return;
  if(clientThis === null || !clientThis.equals(p)) {
    clientThis=p;
    S.composer=1;
    log('captured Composer this='+p);
    refreshActual();
    stateLine();
  }
}

function ncall(name,args) {
  if(!fn[name]) return null;
  try { return fn[name].apply(null,args); }
  catch(e){ warn(name+' call '+e); return null; }
}

const displays = new Map();
function getDisplay(key) {
  let s=displays.get(key);
  if(!s){s={key,external:null,configs:new Map(),activeConfig:null,lastApplyMs:0};displays.set(key,s);}
  return s;
}
function ensureCfg(s,id) {
  let c=s.configs.get(id);
  if(!c){c={id,width:null,height:null,vsync:null,group:null};s.configs.set(id,c);}
  return c;
}
function queryConn(s) {
  if(!clientThis || !fn.getDisplayConnectionType) return s.external;
  const out=Memory.alloc(4);out.writeS32(INVALID);
  ncall('getDisplayConnectionType',[clientThis,displayArg(s.key),out]);
  const v=out.readS32();
  if(v===0 || v===1)s.external=(v===1);
  return s.external;
}
function queryAttr(s,id,a) {
  if(!clientThis || !fn.getDisplayAttribute)return INVALID;
  const out=Memory.alloc(4);out.writeS32(INVALID);
  ncall('getDisplayAttribute',[clientThis,displayArg(s.key),id,a,out]);
  return out.readS32();
}
function queryCfg(s,id) {
  const w=queryAttr(s,id,ATTR.WIDTH);
  const h=queryAttr(s,id,ATTR.HEIGHT);
  const v=queryAttr(s,id,ATTR.VSYNC_PERIOD);
  if(!(w>=64 && h>=64 && v>=1000000 && v<=100000000))return false;
  const c=ensureCfg(s,id);c.width=w;c.height=h;c.vsync=v;
  const g=queryAttr(s,id,ATTR.CONFIG_GROUP);if(g!==INVALID)c.group=g;
  return true;
}
function scanCfgs(s) {
  let found=0,invalidRun=0;
  for(let id=0;id<=63;id++){
    if(queryCfg(s,id)){found++;invalidRun=0;}
    else if(found){invalidRun++;if(invalidRun>=10)break;}
  }
  return found;
}
function queryActive(s) {
  if(!clientThis || !fn.getActiveConfig)return s.activeConfig;
  const out=Memory.alloc(4);out.writeS32(INVALID);
  ncall('getActiveConfig',[clientThis,displayArg(s.key),out]);
  const v=out.readS32();
  if(v>=0 && v<100000){s.activeConfig=v;if(!s.configs.has(v))queryCfg(s,v);}
  return s.activeConfig;
}

function extDisplay() {
  const hwcStr=pstr(P.hwc);
  if(!hwcStr)return null;
  const key=canon(new Int64(hwcStr));
  if(!key)return null;
  const s=getDisplay(key);
  if(s.external===null && queryConn(s)!==true)return null;
  if(s.external!==true)return null;
  S.hwc=hwcStr;
  S.phys=pstr(P.phys);
  return s;
}

function refreshActual() {
  if(!clientThis)return;
  const s=extDisplay();
  if(!s)return;
  const ac=queryActive(s);
  const c=s.configs.get(ac);
  if(c && c.width && c.height && c.vsync){
    S.actualConfig=ac;
    S.width=c.width;
    S.height=c.height;
    S.refresh=hz(c.vsync).toFixed(6);
    S.period=c.vsync;
  }
}

function monotonicNowNs() {
  try {
    const a=Module.findGlobalExportByName('clock_gettime');
    const cg=new NativeFunction(a,'int',['int','pointer']);
    const t=Memory.alloc(16);
    if(cg(1,t)!==0)return new Int64(0);
    const sec=t.readS64().toNumber(), ns=t.add(8).readS64().toNumber();
    return new Int64(String(Math.trunc(sec*1000000000+ns)));
  } catch(_){return new Int64(0);}
}

function applyHwc(s,configId) {
  if(!clientThis || !fn.setActiveConfigWithConstraints)return false;
  if(!s.configs.has(configId) && !queryCfg(s,configId))return false;
  const c=s.configs.get(configId);
  if(!c || !c.vsync)return false;

  const cons=Memory.alloc(16);
  cons.writeS64(monotonicNowNs());
  cons.add(8).writeU8(0);

  const timeline=Memory.alloc(24);
  for(let i=0;i<24;i++)timeline.add(i).writeU8(0);

  log('HWC APPLY cfg='+configId+' '+c.width+'x'+c.height+'@'+hz(c.vsync).toFixed(3));
  ncall('setActiveConfigWithConstraints',[clientThis,displayArg(s.key),configId,cons,timeline]);
  s.lastApplyMs=Date.now();
  return true;
}

// ---- DMC sync, correct Android::Fps ABI ----
// OOS keeps the original symbol-enumeration path. HyperOS 3 may hide these
// functions from enumerateSymbols() even though they are real ELF exports, so
// fall back to exact exports from libsurfaceflinger.so.
let dmc=null, setActiveMode=null, pendingSync=null;
try {
  let locked=null, pub=null, resolver='legacy', captureSyms=[];

  try {
    const sf=Process.getModuleByName('surfaceflinger');
    const syms=sf.enumerateSymbols();
    locked=syms.find(s=>s.name.indexOf('DisplayModeController19setActiveModeLocked')!==-1);
    pub=syms.find(s=>s.name.indexOf('DisplayModeController13setActiveMode')!==-1 &&
                    s.name.indexOf('Locked')===-1);
  } catch(_) {}

  if(!(locked && pub)){
    let impl=null;
    try { impl=Process.getModuleByName('libsurfaceflinger.so'); } catch(_) {}
    if(impl){
      const LOCKED='_ZN7android7display21DisplayModeController19setActiveModeLockedENS_17PhysicalDisplayIdENS_13DisplayModeIdENS_3FpsES4_';
      const PUBLIC='_ZN7android7display21DisplayModeController13setActiveModeENS_17PhysicalDisplayIdENS_13DisplayModeIdENS_3FpsES4_';
      const la=impl.findExportByName(LOCKED);
      const pa=impl.findExportByName(PUBLIC);
      if(la && pa){
        locked={address:la,name:LOCKED};
        pub={address:pa,name:PUBLIC};
        resolver='exact-export';

        // These members are called frequently enough on HyperOS to capture the
        // DisplayModeController this-pointer without issuing any synthetic call.
        const captures=[
          '_ZNK7android7display21DisplayModeController14selectorPtrForENS_17PhysicalDisplayIdE',
          '_ZNK7android7display21DisplayModeController16isModeSetPendingENS_17PhysicalDisplayIdE',
          '_ZNK7android7display21DisplayModeController13getActiveModeENS_17PhysicalDisplayIdE',
          '_ZNK7android7display21DisplayModeController14getDesiredModeENS_17PhysicalDisplayIdE',
          '_ZNK7android7display21DisplayModeController14getPendingModeENS_17PhysicalDisplayIdE',
          '_ZN7android7display21DisplayModeController21updateKernelIdleTimerENS_17PhysicalDisplayIdE'
        ];
        captures.forEach(n=>{
          const a=impl.findExportByName(n);
          if(a)captureSyms.push({address:a,name:n});
        });
      }
    }
  }

  function captureDmc(p,from) {
    if(!p || p.isNull())return;
    if(dmc===null || !dmc.equals(p)){
      dmc=p;
      S.dmc=1;
      log('captured DMC*='+dmc+' via '+from);
      stateLine();
      if(pendingSync){
        const t=pendingSync;pendingSync=null;
        // DMC::setActiveMode is safe from the agent thread on tested A16 stacks.
        setTimeout(()=>syncDmc(t),50);
      }
    }
  }

  if(locked && pub){
    const Fps=['float','int64'];
    setActiveMode=new NativeFunction(pub.address,'void',['pointer','uint64','int',Fps,Fps]);
    Interceptor.attach(locked.address,{
      onEnter(args){captureDmc(args[0],'setActiveModeLocked');}
    });
    captureSyms.forEach(x=>{
      if(x.address.equals(locked.address))return;
      Interceptor.attach(x.address,{onEnter(args){captureDmc(args[0],x.name);}});
    });
    log('DMC hooks ready resolver='+resolver+' locked='+locked.address+' public='+pub.address+
        ' capture='+captureSyms.length);
  } else {
    S.lastError='dmc_symbols_missing';
  }
} catch(e) {
  S.lastError='dmc_hook_failed';
  warn('DMC setup '+e);
}

function syncDmc(req) {
  if(!setActiveMode){
    S.lastDmc=0;S.lastError='dmc_function_missing';stateLine();return false;
  }
  if(dmc===null){
    pendingSync=req;
    S.lastDmc='pending';
    S.lastError='dmc_pointer_not_captured';
    stateLine();
    return false;
  }
  try {
    const rr=Number(req.refresh), period=String(req.period);
    log('DMC SYNC phys='+req.phys+' mode='+req.sfmode+' '+rr+'Hz period='+period);
    setActiveMode(
      dmc,
      uint64(String(req.phys)),
      Number(req.sfmode),
      [rr,int64(period)],
      [rr,int64(period)]
    );
    S.lastDmc=1;S.lastError='';
    stateLine();
    return true;
  } catch(e) {
    S.lastDmc=0;S.lastError='dmc_call_failed_'+String(e);
    stateLine();
    return false;
  }
}

// ---- Scheduler / pacesetter ----
// OOS keeps the original direct-call behavior. HyperOS 3 requires
// setPacesetterDisplay() to run on the SurfaceFlinger main thread. We therefore
// queue the request and execute it at SurfaceFlinger::commit() onLeave.
let scheduler=null, setPacesetterDisplay=null, pendingPace=null;
let pacesetterMainThread=false, commitHookReady=false;
let unregisterHookReady=false;
try {
  let setSym=null, updateSym=null, resolver='legacy';
  let schedulerCapture=[];
  let commitAddr=null;

  try {
    const sf=Process.getModuleByName('surfaceflinger');
    const syms=sf.enumerateSymbols();
    setSym=syms.find(s=>s.name.indexOf('Scheduler20setPacesetterDisplay')!==-1);
    updateSym=syms.find(s=>s.name.indexOf('Scheduler24updatePhaseConfiguration')!==-1);
  } catch(_) {}

  if(!setSym){
    let impl=null;
    try { impl=Process.getModuleByName('libsurfaceflinger.so'); } catch(_) {}
    if(impl){
      const SET='_ZN7android9scheduler9Scheduler20setPacesetterDisplayENS_17PhysicalDisplayIdE';
      const COMMIT='_ZN7android14SurfaceFlinger6commitENS_17PhysicalDisplayIdERKNS_3ftl8SmallMapIS1_PKNS_9scheduler11FrameTargetELm3ENSt3__18equal_toIS1_EEEE';
      const GETRR='_ZNK7android9scheduler9Scheduler24getPacesetterRefreshRateEv';
      const GETVSYNC='_ZNK7android9scheduler9Scheduler24getPacesetterVsyncPeriodEv';
      const UNREG2='_ZN7android9scheduler9Scheduler17unregisterDisplayENS_17PhysicalDisplayIdES2_';
      const UNREG1='_ZN7android9scheduler9Scheduler17unregisterDisplayENS_17PhysicalDisplayIdE';

      const sa=impl.findExportByName(SET);
      if(sa){
        setSym={address:sa,name:SET};
        resolver='exact-export-main-thread';
        pacesetterMainThread=true;
        commitAddr=impl.findExportByName(COMMIT);

        [GETRR,GETVSYNC].forEach(n=>{
          let a=null;
          try {
            const d=DebugSymbol.fromName(n);
            if(d && d.address && !d.address.isNull())a=d.address;
          } catch(_) {}
          if(!a){
            try {
              const x=impl.enumerateSymbols().find(s=>s.name===n);
              if(x)a=x.address;
            } catch(_) {}
          }
          if(a)schedulerCapture.push({address:a,name:n});
        });
      }
    }
  }

  function captureScheduler(p,from) {
    if(!p || p.isNull())return;
    if(scheduler===null || !scheduler.equals(p)){
      scheduler=p; S.scheduler=1;
      log('captured Scheduler*='+scheduler+' via '+from);
      stateLine();
      if(pendingPace!==null && !pacesetterMainThread){
        const t=pendingPace; pendingPace=null;
        setTimeout(()=>applyPacesetter(t),80);
      }
    }
  }

  if(setSym){
    setPacesetterDisplay=new NativeFunction(setSym.address,'void',['pointer','uint64']);
    Interceptor.attach(setSym.address,{onEnter(args){captureScheduler(args[0],'setPacesetterDisplay');}});
  }
  if(updateSym){
    Interceptor.attach(updateSym.address,{onEnter(args){captureScheduler(args[0],'updatePhaseConfiguration');}});
  }
  schedulerCapture.forEach(x=>{
    Interceptor.attach(x.address,{onEnter(args){captureScheduler(args[0],x.name);}});
  });

  // HyperOS hot-unplug recovery. Waiting for the shell supervisor and then a
  // future commit is too late once the removed external display is still the
  // pacesetter: the scheduler can collapse to ~1 Hz. Hook Scheduler::unregisterDisplay
  // and restore the internal display immediately after the unregister call returns,
  // while we are still on SurfaceFlinger's main thread and Scheduler locks are gone.
  if(pacesetterMainThread){
    try {
      let impl=null;
      try { impl=Process.getModuleByName('libsurfaceflinger.so'); } catch(_) {}
      if(impl){
        const UNREG2='_ZN7android9scheduler9Scheduler17unregisterDisplayENS_17PhysicalDisplayIdES2_';
        const UNREG1='_ZN7android9scheduler9Scheduler17unregisterDisplayENS_17PhysicalDisplayIdE';
        let ua=impl.findExportByName(UNREG2);
        let unregHasActive=true;
        if(!ua){ ua=impl.findExportByName(UNREG1); unregHasActive=false; }
        if(ua){
          unregisterHookReady=true;
          log('Scheduler unregister restore hook='+ua+' activeArg='+unregHasActive);
          Interceptor.attach(ua,{
            onEnter(args){
              captureScheduler(args[0],'unregisterDisplay');
              this.restore=false;
              this.target='';
              try {
                const enabled=pstr(P.paceenabled)==='1';
                const paceTarget=pstr(P.pacephys);
                const removedId=new UInt64(args[1].toString()).toString();
                let activeId='';
                if(unregHasActive){
                  activeId=new UInt64(args[2].toString()).toString();
                } else {
                  // Old/vendor one-argument ABI fallback only.
                  activeId=pstr(P.internalphys);
                }

                // Do NOT rely on debug.oah.phys here: the shell supervisor may
                // clear it as soon as hot-unplug is observed, racing this hook.
                // debug.oah.pacephys is the stable target that was actually
                // promoted, and unregisterDisplay() itself tells us the
                // surviving active display on the two-argument Android 16 ABI.
                if(enabled && paceTarget && removedId===paceTarget &&
                   activeId && activeId!==removedId){
                  this.restore=true;
                  this.target=activeId;
                  log('PACESETTER AUTO-RESTORE armed removed='+removedId+
                      ' active='+activeId+' paceTarget='+paceTarget);
                }
              } catch(e){ warn('unregister restore arm '+e); }
            },
            onLeave(retval){
              if(!this.restore || !this.target || !scheduler || !setPacesetterDisplay)return;
              const target=this.target;
              const tid=Process.getCurrentThreadId();
              if(tid===Process.id){
                try {
                  log('PACESETTER AUTO-RESTORE MAIN phys='+target+' tid='+tid);
                  setPacesetterDisplay(scheduler,uint64(String(target)));
                  pendingPace=null;
                  S.lastPace=1; S.lastError=''; stateLine();
                  return;
                } catch(e){
                  warn('unregister direct restore '+e);
                }
              }
              // Very defensive fallback for vendor variants that unregister off-main.
              pendingPace=String(target);
              S.lastPace='pending';
              S.lastError='';
              log('PACESETTER AUTO-RESTORE queued phys='+target+' tid='+tid);
              stateLine();
            }
          });
        }
      }
    } catch(e){ warn('Scheduler unregister hook '+e); }
  }

  if(pacesetterMainThread && commitAddr){
    commitHookReady=true;
    Interceptor.attach(commitAddr,{
      onLeave(retval){
        if(pendingPace===null || !scheduler || !setPacesetterDisplay)return;
        const tid=Process.getCurrentThreadId();
        if(tid!==Process.id)return;

        const target=pendingPace;
        pendingPace=null;
        try {
          log('PACESETTER MAIN SET phys='+target+' tid='+tid);
          setPacesetterDisplay(scheduler,uint64(String(target)));
          S.lastPace=1; S.lastError=''; stateLine();
        } catch(e) {
          S.lastPace=0; S.lastError='pacesetter_call_failed_'+String(e); stateLine();
        }
      }
    });
  }

  if(!setSym){
    S.lastError='pacesetter_symbol_missing';
  } else if(pacesetterMainThread && !commitHookReady){
    S.lastError='pacesetter_commit_symbol_missing';
  } else {
    log('Scheduler pacesetter ready resolver='+resolver+' set='+setSym.address+
        ' update='+(updateSym?updateSym.address:'null')+
        ' captures='+schedulerCapture.length+
        ' commit='+(commitAddr||'null')+
        ' unregisterRestore='+unregisterHookReady);
  }
} catch(e) {
  S.lastError='scheduler_hook_failed';
  warn('Scheduler setup '+e);
}

function applyPacesetter(phys) {
  if(!setPacesetterDisplay){
    S.lastPace=0; S.lastError='pacesetter_function_missing'; stateLine(); return false;
  }

  if(pacesetterMainThread){
    if(!commitHookReady){
      S.lastPace=0; S.lastError='pacesetter_commit_symbol_missing'; stateLine(); return false;
    }
    pendingPace=String(phys);
    S.lastPace='pending';
    S.lastError='';
    log('PACESETTER QUEUED phys='+phys+' waiting_sf_main_commit');
    stateLine();
    return false;
  }

  if(scheduler===null){
    pendingPace=String(phys);
    S.lastPace='pending'; S.lastError='scheduler_pointer_not_captured'; stateLine(); return false;
  }
  try {
    log('PACESETTER SET phys='+phys);
    setPacesetterDisplay(scheduler,uint64(String(phys)));
    S.lastPace=1; S.lastError=''; stateLine(); return true;
  } catch(e) {
    S.lastPace=0; S.lastError='pacesetter_call_failed_'+String(e); stateLine(); return false;
  }
}

let lastSeq='';
let hwcGeneration=0;
function readRequest(seq) {
  return {
    seq:seq || pstr(P.seq),
    action:pstr(P.action),
    phys:pstr(P.phys),
    hwc:pstr(P.hwc),
    sfmode:pnum(P.sfmode,-1),
    config:pnum(P.config,-1),
    width:pnum(P.width,0),
    height:pnum(P.height,0),
    refresh:pnum(P.refresh,0),
    period:pnum(P.period,0),
    pacephys:pstr(P.pacephys)
  };
}

function handleRequest() {
  // Hot path: read only the sequence property while idle. The old code read all
  // request properties every 120 ms, which was unnecessary overhead in SF.
  const seq=pstr(P.seq);
  if(!seq || seq===lastSeq)return;
  const r=readRequest(seq);
  lastSeq=r.seq;
  S.lastSeq=r.seq;S.lastAction=r.action||'';
  S.lastHwc='';S.lastDmc='';S.lastError='';

  if(r.action==='apply'){
    if(!clientThis){S.lastHwc=0;S.lastError='composer_not_captured';stateLine();return;}
    const s=extDisplay();
    if(!s){S.lastHwc=0;S.lastError='external_hwc_not_found';stateLine();return;}
    if(r.config<0){S.lastHwc=0;S.lastError='invalid_config';stateLine();return;}

    const generation=++hwcGeneration;
    S.lastHwc='pending';
    S.lastDmc='';
    S.lastError='';
    stateLine();

    const matchesTarget=()=>{
      refreshActual();
      const active=queryActive(s);
      const c=s.configs.get(active);
      const attrMatch=!!(c && c.width===r.width && c.height===r.height &&
        Math.abs(hz(c.vsync)-Number(r.refresh))<0.25);
      return {ok:(active===r.config || attrMatch),active,c};
    };

    const pre=matchesTarget();
    if(pre.ok){
      S.lastHwc=1;S.lastError='';
      syncDmc(r);refreshActual();stateLine();return;
    }

    let attempt=0;
    const maxAttempts=3;

    const startAttempt=()=>{
      if(generation!==hwcGeneration)return;

      // The known-good V1 path deliberately kept >=800 ms between Composer
      // requests. Honor the same vendor settling window instead of hammering HWC.
      const since=Date.now()-(s.lastApplyMs||0);
      if(since<820){setTimeout(startAttempt,830-since);return;}

      attempt++;
      S.lastHwc='pending';S.lastError='';
      log('HWC attempt '+attempt+'/'+maxAttempts+' cfg='+r.config);
      const issued=applyHwc(s,r.config);
      if(!issued){
        if(attempt<maxAttempts)setTimeout(startAttempt,830);
        else{S.lastHwc=0;S.lastError='hwc_apply_call_failed';stateLine();}
        return;
      }

      let polls=0;
      const poll=()=>{
        if(generation!==hwcGeneration)return;
        const v=matchesTarget();
        if(v.ok){
          S.lastHwc=1;S.lastError='';
          log('HWC verified attempt='+attempt+' active='+v.active);
          syncDmc(r);refreshActual();stateLine();return;
        }
        polls++;
        if(polls<8){setTimeout(poll,100);return;}

        if(attempt<maxAttempts){
          warn('HWC settle timeout attempt='+attempt+' active='+v.active+' target='+r.config);
          setTimeout(startAttempt,120);
        }else{
          // Final late read. Some OPlus stacks publish getActiveConfig noticeably
          // after the monitor has already switched.
          setTimeout(()=>{
            if(generation!==hwcGeneration)return;
            const final=matchesTarget();
            if(final.ok){
              S.lastHwc=1;S.lastError='';
              log('HWC late verification success active='+final.active);
              syncDmc(r);
            }else{
              S.lastHwc=0;
              S.lastError='hwc_verify_timeout_active_'+final.active+'_target_'+r.config;
            }
            refreshActual();stateLine();
          },450);
        }
      };
      setTimeout(poll,120);
    };

    startAttempt();
  } else if(r.action==='sync'){
    syncDmc(r);
  } else if(r.action==='pace'){
    if(!r.pacephys){S.lastPace=0;S.lastError='pace_phys_missing';stateLine();}
    else applyPacesetter(r.pacephys);
  }
  stateLine();
}

function hookComposer() {
  const m=findComposerModule();
  if(!m){setTimeout(hookComposer,500);return;}

  ['setActiveConfigWithConstraints','getDisplayAttribute','getDisplayConnectionType','getActiveConfig'].forEach(name=>{
    const e=methodExport(m,name);if(e)addr[name]=e.address;
  });

  function wrap(name,ret,args){if(addr[name])fn[name]=new NativeFunction(addr[name],ret,args);}
  wrap('setActiveConfigWithConstraints','pointer',['pointer','int64','int','pointer','pointer']);
  wrap('getDisplayAttribute','pointer',['pointer','int64','int','int','pointer']);
  wrap('getDisplayConnectionType','pointer',['pointer','int64','pointer']);
  wrap('getActiveConfig','pointer',['pointer','int64','pointer']);

  if(!addr.setActiveConfigWithConstraints || !addr.getDisplayAttribute){
    S.lastError='composer_symbols_missing';stateLine();return;
  }

  ['getDisplayAttribute','getActiveConfig','getDisplayConnectionType','setActiveConfigWithConstraints'].forEach(name=>{
    if(addr[name])Interceptor.attach(addr[name],{onEnter(args){rememberThis(args[0]);}});
  });

  ['executeCommands','getDisplayVsyncPeriod','presentOrValidateDisplay','validateDisplay'].some(name=>{
    const e=methodExport(m,name);if(!e)return false;
    Interceptor.attach(e.address,{onEnter(args){rememberThis(args[0]);}});
    return true;
  });

  S.engine=1;
  log('agent ready composer='+m.name);
  stateLine();
}

hookComposer();

setInterval(()=>{
  try { handleRequest(); }
  catch(e){ S.lastError='cmd_loop_'+String(e); stateLine(); }
},80);

setInterval(()=>{
  try { refreshActual(); stateLine(); }
  catch(e){ S.lastError='state_loop_'+String(e); stateLine(); }
},700);

setInterval(function(){},1000);
