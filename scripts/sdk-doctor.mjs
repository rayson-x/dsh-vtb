/** Read-only pinned SDK diagnostics; never prints credentials or private implementation. */
import { createRequire } from 'node:module';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SDK_PIN } from './sdk-source.mjs';
export async function inspectSdk(sourceRepo=process.env.AIVTB_SDK_REPO) {
 if(!sourceRepo)sourceRepo=await readFile(resolve('.deps/sdk-source.json'),'utf8').then(JSON.parse).then(x=>x.sourceRepo).catch(()=>undefined);
 if(!sourceRepo)throw Error('Configure the authorized private checkout with npm run harness:sdk -- /path');
 const root=await realpath(sourceRepo),git=(path)=>execFileSync('git',['-C',root,'show',SDK_PIN+':'+path],{maxBuffer:16*1024*1024});
 const manifest=JSON.parse(git('sandbox/sdk/runtime-manifest.json').toString()),lock=git('pnpm-lock.yaml');
 const require=createRequire(join(root,'sandbox/package.json'));
 const libraries=[];
 for(const [name,expected] of Object.entries(manifest.libraries)){
  try{
   let resolved;try{resolved=require.resolve(name);}catch{resolved=require.resolve(name+'/package.json');}
   const entry=await realpath(resolved);let at=dirname(entry),pkg;
   for(;;){pkg=await readFile(join(at,'package.json'),'utf8').then(JSON.parse).catch(()=>undefined);if(pkg?.name===name)break;const up=dirname(at);if(up===at)throw Error('package root not found');at=up;}
   libraries.push({name,expected,installed:pkg.version,versionMatches:pkg.version===expected,licence:pkg.license??null,licenseDecision:'inventory-only; no commercial authorization inferred'});
  }catch(error){libraries.push({name,expected,installed:null,versionMatches:false,error:'Unavailable to pinned SDK resolver'});}
 }
 return{schema:1,sdkCommit:SDK_PIN,lockSha256:createHash('sha256').update(lock).digest('hex'),node:process.versions.node,libraries,dependencyVersionsMatch:libraries.every(x=>x.versionMatches),privateImplementationVendored:false,sourceIsFixedGitObject:true,dependencyInstall:'local installed closure; use clean pinned checkout and pnpm --frozen-lockfile for independent reproduction',externalAuthorization:'not inferred from local access'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const report=await inspectSdk();const output=process.argv[2]??'.deps/sdk-doctor.json';await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output:resolve(output),sdkCommit:report.sdkCommit,libraries:report.libraries.length,dependencyVersionsMatch:report.dependencyVersionsMatch,mismatches:report.libraries.filter(x=>!x.versionMatches).map(({name,expected,installed})=>({name,expected,installed}))}));if(!report.dependencyVersionsMatch)process.exitCode=1;}
