const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const mode = process.argv[2];
const mobile = mode === 'wechat';
const url = process.env.SITE || 'http://127.0.0.1:4226/samsara-wechat-preview/';
const origin = new URL(url).origin;
const path = new URL(url).pathname.replace(/\/$/, '');
const ua = 'Mozilla/5.0 (Linux; Android 15; vivo V2324HA) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.77';
const profile = mobile ? {viewport:{width:393,height:740},userAgent:ua,isMobile:true,hasTouch:true} : {viewport:{width:1280,height:720}};
const log = (...args)=>console.log(mode, ...args);
(async()=>{
  const args = ['--disable-dev-shm-usage','--enable-unsafe-swiftshader'];
  if (!mobile) args.push('--autoplay-policy=no-user-gesture-required');
  if(url.startsWith('https://') && process.env.HTTPS_PROXY) args.push('--proxy-server='+process.env.HTTPS_PROXY);
  const b = await chromium.launch({executablePath:process.env.CHROME_BIN || chromium.executablePath(),headless:true,args});
  let p;
  try {
    const ctx = await b.newContext({...profile,deviceScaleFactor:1,locale:'zh-CN',serviceWorkers:'block'});
    p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.enable');
    if(process.env.RATE)await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:120,downloadThroughput:Number(process.env.RATE)*1e6/8,uploadThroughput:1.5e6/8,connectionType:'cellular4g'}); await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
    p.on('requestfailed',r=>console.log('FAIL',r.url(),r.failure()));p.on('requestfinished',r=>{if(r.url().match(/mp4|m4a|json|opus/))console.log('DONE',elapsed(),r.url().split('/').pop());});const begin=Date.now(); const elapsed=()=>+((Date.now()-begin)/1000).toFixed(2);
    const errors=[], media=new Set(), nonlocal=new Set(), httpErrors=[];
    p.on('request',r=>{const u=new URL(r.url()); if(u.protocol.startsWith('http')){if(u.origin!==origin) nonlocal.add(u.origin);if(/\/(audios|videos)\//.test(u.pathname))media.add(u.pathname);}});
    p.on('response',r=>{if(r.status()>=400)httpErrors.push([r.status(),r.url()]);});
    p.on('pageerror',e=>errors.push(e.message));
    p.on('console',m=>{
      if (m.type()!=='error') return;
      const location=m.location().url;
      if (location===origin+'/favicon.ico' && m.text().includes('404')) {log('original root favicon probe returned 404');return;}
      errors.push({message:m.text(),location});
    });
    await p.addInitScript(()=>{
      window.mediaProgress = {};
      function track(a) {
        if (!(a instanceof HTMLMediaElement) || !a.currentSrc || a.muted || a.volume<=0) return;
        const name = new URL(a.currentSrc).pathname.split('/').pop();
        if (!a.paused && a.readyState >= 2 && a.currentTime > 0) window.mediaProgress[name] = Math.max(window.mediaProgress[name] || 0, a.currentTime);
      }
      setInterval(()=>document.querySelectorAll('audio,video').forEach(track),120);
    });
    const wait = s=>p.locator(s).first().waitFor({state:'visible',timeout:90000});
    async function hit(selector, index=0, allowScroll=false) {
      const l=p.locator(selector).nth(index); await l.waitFor({state:'visible',timeout:10000});
      if (allowScroll) await l.scrollIntoViewIfNeeded();
      const point=await l.evaluate(el=>{
        const r=el.getBoundingClientRect(), x=r.left+r.width/2,y=r.top+r.height/2;
        const h=document.elementFromPoint(x,y);
        return {x,y,ok:el.contains(h),hit:h?.className,viewport:[innerWidth,innerHeight]};
      });
      assert.ok(point.ok,selector+' hit '+JSON.stringify(point));
      if(mobile) await p.touchscreen.tap(point.x,point.y); else await p.mouse.click(point.x,point.y);
    }
    async function tapIntro() {
      const {width,height}=p.viewportSize();
      const pt=[Math.round(width*.22),Math.round(height*.31)];
      assert.ok(await p.evaluate(([x,y])=>!!document.elementFromPoint(x,y)?.closest('.intro'),pt));
      if(mobile) await p.touchscreen.tap(...pt); else await p.mouse.click(...pt);
    }
    async function audioPlaying(file) {
      await p.waitForFunction(f=>(window.mediaProgress[f]||0)>0.15,file,{timeout:45000});
    }
    async function motion(label) {
      const read=()=>p.evaluate(()=>{
        const src=document.querySelector('.video-stage video') || document.querySelector('.video-stage canvas');
        if (!src) return '';
        const canvas=document.createElement('canvas'); canvas.width=96; canvas.height=54;
        const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(src,0,0,96,54);
        const data=ctx.getImageData(0,0,96,54).data;
        let max=0;for(let i=0;i<data.length;i+=4)max=Math.max(max,data[i],data[i+1],data[i+2]);
        return max>12?canvas.toDataURL():'';
      });
      let first=''; for(let i=0;i<16;i++){
        const frame=await read(); if(frame){if(first&&frame!==first)return;first=frame;}
        await p.waitForTimeout(110);
      }
      throw new Error('No visible frame change at '+label);
    }
    async function stage(expectedSideways,width,height) {
      await p.waitForFunction(({s,w,h})=>{
        const root=document.querySelector('#game-viewport');
        return !!root && root.classList.contains('sideways')===s && (root.clientWidth||innerWidth)===w && (root.clientHeight||innerHeight)===h && !document.querySelector('.rotate-gate')?.getClientRects().length;
      },{s:expectedSideways,w:width,h:height},{timeout:8000});
    }
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:65000});
    await wait('.intro.clickable');
    await stage(mobile,mobile?740:1280,mobile?393:720);
    await motion('opening'); log('interactive and moving at',elapsed());
    if(!mobile){
      await hit('.lang-toggle button[lang="en"]'); assert.equal(await p.locator('html').getAttribute('lang'),'en');
      await hit('.lang-toggle button[lang="zh-CN"]'); assert.equal(await p.locator('html').getAttribute('lang'),'zh-CN');
    }
    await tapIntro(); await audioPlaying('2.m4a'); await motion('clip 2');
    await wait('.continue-hint'); await tapIntro();
    await audioPlaying('3.m4a'); await audioPlaying('bg.opus'); await motion('clip 3');
    await wait('.cell'); assert.equal(await p.locator('.cell').count(),12);
    log('opening, natural transitions, music, 12 country choices passed');
    await hit('.cell',0); await audioPlaying('4.m4a'); await motion('clip 4');
    await wait('.handle-label'); await hit('.handle-label',1); const stair=Date.now();
    await audioPlaying('5.m4a'); await motion('clip 5'); log('stair click to soundtrack and moving picture', ((Date.now()-stair)/1000).toFixed(2));
    await wait('.alloc-title'); assert.ok(await p.locator('.start-row').isDisabled());
    const first=p.locator('.alloc-value').first(); const n=Number(await first.textContent());
    await hit('.alloc-stats .alloc-row:first-child .alloc-step',1); assert.equal(Number(await first.textContent()),n+1);
    if(mobile){
      await p.setViewportSize({width:740,height:393}); await stage(false,740,393);
      assert.equal(Number(await first.textContent()),n+1);
      await p.setViewportSize({width:393,height:740}); await stage(true,740,393);
      assert.equal(Number(await first.textContent()),n+1);
    }
    await hit('.alloc-stats .alloc-row:first-child .alloc-step',0); assert.equal(Number(await first.textContent()),n);
    await hit('.random-row'); assert.ok(await p.locator('.start-row').isEnabled());
    await hit('.start-row'); await audioPlaying('6.m4a'); await motion('clip 6');
    await wait('.stair-log-viewport .step'); 
    const countBefore=await p.locator('.stair-log-viewport .step').count();
    await p.waitForFunction(n=>document.querySelectorAll('.stair-log-viewport .step').length>n || !!document.querySelector('.controls button'),countBefore,{timeout:18000});
    log('allocation, advancing video and automatic life text passed');
    for(let i=0;i<230&&!await p.locator('.controls button').count();i++){
      if(mobile){await p.touchscreen.tap(32,54); await p.touchscreen.tap(32,54);}
      else{await p.keyboard.press('Space');await p.keyboard.press('Space');}
      await p.waitForTimeout(90);
    }
    await wait('.controls button'); await hit('.controls button'); await audioPlaying('7.m4a'); await motion('clip 7');
    await wait('.summary .actions button');
    if(mobile){
      await hit('.actions button',0,true); await wait('.save-overlay img');
      const receipt=p.locator('.save-overlay img');
      await p.waitForFunction(()=>document.querySelector('.save-overlay img')?.naturalHeight>100);
      const data=await receipt.getAttribute('src');
      assert.ok(data.startsWith('data:image/png;base64,'));
      fs.writeFileSync('/tmp/samsara-grey-'+(process.env.SITE?.startsWith('https')?'public-':'local-')+'wechat-receipt.png',Buffer.from(data.split(',')[1],'base64'));
      await hit('.save-close'); assert.equal(await p.locator('.save-overlay').count(),0);
    }else{
      const response=p.waitForResponse(r=>r.url().endsWith('/__exhibit/print')&&r.request().method()==='POST',{timeout:20000});
      await hit('.actions button',0); assert.equal((await response).status(),200);
    }
    await hit('.actions button',1,true); await motion('restart'); await wait('.intro.clickable'); await motion('restarted opening');
    for(let i=1;i<=8;i++)assert.ok(media.has(path+'/videos/'+i+'.mp4'),'missing video '+i);
    assert.deepEqual([...nonlocal],[]);assert.deepEqual(httpErrors,[]);assert.deepEqual(errors,[]);
    log('all 8 video requests, visible transitions, sound 2–7 and BG, summary, receipt, restart passed; zero external requests or gameplay errors');
  } catch(e) {
    if(p) {console.error('STATE',await p.evaluate(()=>({text:document.body.innerText.slice(0,380),audio:window.mediaProgress,viewport:[innerWidth,innerHeight]})).catch(()=>null));await p.screenshot({path:'/tmp/samsara-final-'+mode+'-diagnostic.png'}).catch(()=>{});}
    throw e;
  } finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
