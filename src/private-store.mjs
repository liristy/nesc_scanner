import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWrite } from './utils.mjs';

export function privatePowerShell(script, input = '', env = {}) {
  if(process.platform!=='win32') throw new Error('本机加密凭据和会话需要Windows当前用户');
  return new Promise((resolve,reject)=>{
    const code=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); try { ${script} } catch { [Console]::Error.WriteLine('本机加密资料读取或保存失败'); exit 1 }`;
    const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
    let output=''; p.stdout.setEncoding('utf8');p.stdout.on('data',s=>output+=s);p.stderr.resume();
    p.on('error',()=>reject(new Error('无法启动Windows本机加密服务')));
    p.on('close',code=>code===0?resolve(output.trim()):reject(new Error('当前Windows账户无法读取或保存加密资料，请重新配置登录')));
    p.stdin.on('error',()=>{});p.stdin.end(input);
  });
}
export async function savePrivate(file,value) {
  const encrypted=await privatePowerShell("Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",JSON.stringify(value));
  await atomicWrite(file,encrypted);
}
export async function readPrivate(file) {
  let encrypted;try{encrypted=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
  return JSON.parse(await privatePowerShell("Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",encrypted));
}
export async function readCredentials(root) {
  const file=path.join(root,'private/credentials.dpapi');
  const saved=await readPrivate(file);if(saved)return saved;
  const legacy=path.join(root,'.secrets/windows-credential.xml');
  try{await fs.access(legacy);}catch{return null;}
  const value=JSON.parse(await privatePowerShell("$c=Import-Clixml -LiteralPath $env:JY_PRIVATE_SOURCE; @{username=$c.UserName;password=$c.GetNetworkCredential().Password}|ConvertTo-Json -Compress",'',{JY_PRIVATE_SOURCE:legacy}));
  await savePrivate(file,value);return value;
}
