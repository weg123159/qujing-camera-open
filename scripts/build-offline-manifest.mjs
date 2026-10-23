import {createHash} from 'node:crypto';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../dist/',import.meta.url));
const hash = value=>createHash('sha256').update(value).digest('hex');
const normalizeWorker = source=>source
  .replace(/const OFFLINE_BUILD = '[^']+';/,"const OFFLINE_BUILD = 'BUILD_PENDING';")
  .replace(/const OFFLINE_WORKER_SOURCE_HASH = '[^']+';/,"const OFFLINE_WORKER_SOURCE_HASH = 'WORKER_PENDING';");

export async function buildOfflineManifest(root=DEFAULT_ROOT,{write=true}={}) {
  root=path.resolve(root);
  const assets=[];
  async function walk(directory,relative='') {
    const entries=(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for(const entry of entries) {
      const rel=relative ? `${relative}/${entry.name}` : entry.name;
      if(entry.name.startsWith('.') || /^(?:qa[-_.]|test[-_.]|tmp[-_.])/.test(entry.name) || ['sw.js','offline-manifest.json'].includes(rel)) continue;
      if(entry.isSymbolicLink()) throw new Error(`Offline bundle must not contain symlinks: ${rel}`);
      if(entry.isDirectory()) await walk(path.join(directory,entry.name),rel);
      else if(entry.isFile()) {
        if(/[%?#\\]/.test(rel)) throw new Error(`Unsupported offline asset path: ${rel}`);
        const bytes=await readFile(path.join(directory,entry.name));
        assets.push({url:rel,bytes:bytes.length,sha256:hash(bytes)});
      }
    }
  }
  await walk(root);
  assets.sort((a,b)=>a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  for(const required of ['index.html','offline.mjs']) if(!assets.some(item=>item.url===required)) throw new Error(`Missing required offline asset: ${required}`);
  const workerPath=path.join(root,'sw.js');
  const worker=normalizeWorker(await readFile(workerPath,'utf8'));
  if(!worker.includes("const OFFLINE_BUILD = 'BUILD_PENDING';") || !worker.includes("const OFFLINE_WORKER_SOURCE_HASH = 'WORKER_PENDING';")) throw new Error('Service Worker build stamp is missing');
  const workerHash=hash(worker);
  const version=hash(JSON.stringify({schema:1,assets,workerHash}));
  const manifest={schema:1,version,workerHash,totalFiles:assets.length,totalBytes:assets.reduce((sum,item)=>sum+item.bytes,0),assets};
  const stamped=worker.replace("'BUILD_PENDING'",`'${version}'`).replace("'WORKER_PENDING'",`'${workerHash}'`);
  if(write) {
    await writeFile(path.join(root,'offline-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    await writeFile(workerPath,stamped);
  }
  return manifest;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const requested=process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
  const result=await buildOfflineManifest(requested);
  console.log(JSON.stringify({version:result.version,files:result.totalFiles,bytes:result.totalBytes}));
}
