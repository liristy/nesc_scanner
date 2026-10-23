// Temporary read-only diagnostic. Outputs numeric aggregates only.
import JSZip from 'jszip';
import { pathToFileURL } from 'node:url';
import { privateStore } from './private-evidence.mjs';

const sum = a => a.reduce((x,y)=>x+y,0);
const round = x => Math.round(x*10)/10;
const stats = values => {
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  return {count:a.length,total:round(sum(a)),mean:a.length?round(sum(a)/a.length):0,
    p50:a.length?a[Math.floor((a.length-1)*.5)]:0,p90:a.length?a[Math.floor((a.length-1)*.9)]:0,max:a.at(-1)||0};
};
const stageBucket = s => /电芯/.test(s)?'cells':/基本信息/.test(s)?'basic_info':
  /心跳接口/.test(s)?'heartbeat_api':/心跳|捕获/.test(s)?'heartbeat_ui':
  /详情|SN/.test(s)?'detail_identity':'navigation';
const errorBucket = s => /60秒|60000/.test(s)?'timeout_60s':/45秒|45000/.test(s)?'timeout_45s':
  /超时|Timeout|timeout/.test(s)?'other_timeout':/离线/.test(s)?'offline':
  /指令|命令/.test(s)?'device_command':/会话|登录/.test(s)?'session':
  /分页|总数|行数|重复/.test(s)?'pagination':'other';

export function analyze(text) {
  const devices=new Map(),calls=[],samples=new Map(),errors={},markers={},reuse=[],progress=[],exports=[];
  const device=sn=>{if(!devices.has(sn))devices.set(sn,{seconds:0,network:0,rows:0,requests:0,days:0,reused:0,errors:0,cells:0});return devices.get(sn);};
  let first,last,scope;
  for(const line of text.split(/\r?\n/)) {
    const tm=/\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/.exec(line);
    const t=tm?Date.parse(tm[1].replace(' ','T')+'+08:00')/1000:null;
    if(t!=null){first??=t;last=t;}
    let m;
    if((m=/采集范围：当日报警(\d+)块，仅历史跟踪(\d+)块，合并去重(\d+)块/.exec(line))) {
      scope={current:+m[1],history_full:+m[2],total:+m[3]};markers.collection??=t;
    }
    if(/截止范围内报警恢复复查/.test(line))markers.final_recovery??=t;
    if(/保存报告与滚动证据|保存只读测试证据/.test(line))markers.saving??=t;
    if((m=/SN (\S+) (\d{4}-\d\d-\d\d) 心跳接口读取(\d+)条，(\d+)次请求，([\d.]+)秒/.exec(line))) {
      const d=device(m[1]),seconds=+m[5];d.network+=seconds;d.rows+=+m[3];d.requests+=+m[4];d.days++;
      calls.push({seconds,rows:+m[3],requests:+m[4],t});
    }
    if((m=/；([A-Za-z0-9_-]+) (?:已读取|待核实).*本SN含详情\/历史耗时([\d.]+)秒/.exec(line))) {
      device(m[1]).seconds=+m[2];progress.push({t,seconds:+m[2]});
    }
    if((m=/SN (\S+) 复用(\d+)天完整历史心跳/.exec(line)))device(m[1]).reused=+m[2];
    if((m=/SN (\S+) 复用截止.*已核验心跳/.exec(line))){reuse.push(t);device(m[1]).fullReuse=true;}
    if((m=/SN (\S+) (?:心跳证据待核实|电芯证据待复核|平台显示设备离线)[：\s]*(.*)/.exec(line))) {
      const d=device(m[1]);d.errors++;if(/电芯|离线/.test(line))d.cells++;
      const b=errorBucket(line);errors[b]=(errors[b]||0)+1;
    }
    if(/WARN/.test(line)&&/会话|重新登录|自动续查/.test(line))errors.session_or_retry=(errors.session_or_retry||0)+1;
    if((m=/通道 (\d+) → (.+?)：(.+)/.exec(line))&&t!=null) {
      if(!samples.has(t))samples.set(t,new Map());samples.get(t).set(+m[1],stageBucket(m[3]));
    }
    if((m=/报警导出已核对.*：(\d+)条，统计区间内(\d+)条/.exec(line)))exports.push({all:+m[1],inside:+m[2],t});
  }
  const sampled={};const groups=[...samples].sort(([a],[b])=>a-b);
  for(let i=0;i<groups.length-1;i++) {
    const delta=Math.min(30,groups[i+1][0]-groups[i][0]);
    for(const bucket of groups[i][1].values())sampled[bucket]=(sampled[bucket]||0)+delta;
  }
  const ds=[...devices.values()].filter(d=>d.seconds>0);
  const slices=[];
  for(let start=first;start!=null&&start<=last;start+=600) {
    const p=progress.filter(x=>x.t>=start&&x.t<start+600),c=calls.filter(x=>x.t>=start&&x.t<start+600);
    slices.push({from_min:Math.round((start-first)/60),completed:p.length,device_seconds:stats(p.map(x=>x.seconds)),api_seconds:stats(c.map(x=>x.seconds)),api_rows:sum(c.map(x=>x.rows))});
  }
  const summary={log_seconds:last-first,scope,phase_seconds:{
    before_collection:markers.collection-first,collection:markers.final_recovery-markers.collection,
    final_recovery:markers.saving-markers.final_recovery,saving:last-markers.saving},
    device_seconds:stats(ds.map(d=>d.seconds)),non_api_device_seconds:stats(ds.map(d=>d.seconds-d.network)),
    api_calls:stats(calls.map(c=>c.seconds)),api_rows:sum(calls.map(c=>c.rows)),api_requests:sum(calls.map(c=>c.requests)),
    queried_days_per_device:ds.reduce((o,d)=>(o[d.days]=(o[d.days]||0)+1,o),{}),
    cumulative_completed_at_minutes:[10,20,30,40,50,60,70,80].map(minutes=>({minutes,devices:progress.filter(p=>p.t<first+minutes*60).length})),
    reused_days:sum(ds.map(d=>d.reused)),devices_reusing_days:ds.filter(d=>d.reused).length,full_reuse_devices:reuse.length,
    error_counts:errors,sampled_worker_seconds:sampled,ten_minute_slices:slices,
    slowest_anonymous:ds.sort((a,b)=>b.seconds-a.seconds).slice(0,15).map(d=>({seconds:d.seconds,api_seconds:round(d.network),requests:d.requests,rows:d.rows,queried_days:d.days,reused_days:d.reused,errors:d.errors,cell_issues:d.cells})),
    alarm_export_count:exports.length};
  return {summary,devices};
}

async function main() {
  const store=privateStore();await store.verify();
  const results=[];
  for(const [label,id] of [['previous',666440807],['current',668661704]]) {
    const zip=await JSZip.loadAsync(await store.call(`/releases/assets/${id}`,{binary:true}));
    const preferred=label==='current'?'logs/collector.log':'logs/full-window.log';
    const file=zip.file(preferred);if(!file)throw new Error('Required diagnostic log missing');
    const result=analyze(await file.async('string'));results.push(result);
    console.log(JSON.stringify({label,...result.summary}));
  }
  const matched=[...results[0].devices].filter(([sn,d])=>d.seconds>0&&results[1].devices.get(sn)?.seconds>0).map(([sn,a])=>[a,results[1].devices.get(sn)]);
  console.log(JSON.stringify({matched_devices:matched.length,previous_seconds:stats(matched.map(([a])=>a.seconds)),current_seconds:stats(matched.map(([,b])=>b.seconds)),
    previous_api_seconds:stats(matched.map(([a])=>a.network)),current_api_seconds:stats(matched.map(([,b])=>b.network)),
    previous_reused_days:sum(matched.map(([a])=>a.reused)),current_reused_days:sum(matched.map(([,b])=>b.reused)),
    query_day_transition:matched.reduce((o,[a,b])=>{const k=`${a.days}_to_${b.days}`;o[k]=(o[k]||0)+1;return o;},{}),
    previous_rows:sum(matched.map(([a])=>a.rows)),current_rows:sum(matched.map(([,b])=>b.rows))}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Private diagnostic aggregation failed; no raw diagnostics emitted.');process.exitCode=1;});
