// Docker Desktop may ignore the network's default host binding. Recreate only
// this project's published containers with explicit localhost bindings, retaining
// every volume. Keep the original container for rollback until the new one starts.
import http from 'node:http';
const socketPath=process.platform==='win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
async function docker(method,path,body){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined ? undefined : JSON.stringify(body);
    const req=http.request({socketPath,path:`/v1.47${path}`,method,headers:payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {}},res=>{
      let raw='';res.on('data',part=>raw+=part);res.on('end',()=>{
        if(res.statusCode>=400)return reject(new Error(`Docker ${method} failed (${res.statusCode}); original volume data is preserved.`));
        resolve(raw ? JSON.parse(raw) : null);
      });
    });req.on('error',()=>reject(new Error('Local Docker API unavailable.')));req.end(payload);
  });
}
const containers=await docker('GET',`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({label:['com.supabase.cli.project=tlh2']}))}`);
for(const item of containers){
  const name=item.Names[0].slice(1);
  if(!/^supabase_[a-z_]+_tlh2$/.test(name))continue;
  const original=await docker('GET',`/containers/${item.Id}/json`);
  const bindings=original.HostConfig.PortBindings ?? {};
  if(!Object.values(bindings).some(ports=>ports?.some(p=>p.HostIp!=='127.0.0.1')))continue;
  if(original.Mounts.some(m=>m.Type==='volume' && !original.HostConfig.Binds?.some(b=>b.startsWith(`${m.Name}:`))))throw new Error(`${name}: unbound volume needs explicit review; container unchanged.`);
  const backup=`${name}_before_localhost`;
  for(const ports of Object.values(bindings))for(const port of ports ?? [])port.HostIp='127.0.0.1';
  const endpoints=Object.fromEntries(Object.entries(original.NetworkSettings.Networks).map(([network,v])=>[network,{Aliases:v.Aliases}]));
  await docker('POST',`/containers/${item.Id}/stop?t=20`);
  await docker('POST',`/containers/${item.Id}/rename?name=${backup}`);
  let replacement;
  try{
    replacement=await docker('POST',`/containers/create?name=${name}`,{...original.Config,HostConfig:original.HostConfig,NetworkingConfig:{EndpointsConfig:endpoints}});
    await docker('POST',`/containers/${replacement.Id}/start`);
  }catch(e){
    if(replacement)await docker('DELETE',`/containers/${replacement.Id}?force=1`);
    await docker('POST',`/containers/${item.Id}/rename?name=${name}`);
    await docker('POST',`/containers/${item.Id}/start`);
    throw e;
  }
  // No volume removal flag: persistent data remains mounted in the replacement.
  await docker('DELETE',`/containers/${item.Id}`);
  console.log(`${name}: published ports restricted to 127.0.0.1; volumes retained.`);
}
