// Groq adapter for TrustLayer. Server-side only. No signing/execution capability.
// Not enabled until the key's Free tier is verified. No fallback to another provider.
export const GROQ_MODEL = 'openai/gpt-oss-20b';
const URL = 'https://api.groq.com/openai/v1/chat/completions';
export async function groqChat(env, options, fetcher = fetch) {
  if (!env.GROQ_API_KEY) throw new Error('Groq API key not configured');
  if (env.GROQ_FREE_TIER_VERIFIED !== 'true') throw new Error('Groq Free tier not verified; inference disabled');
  if (!Array.isArray(options.messages) || options.messages.length !== 2) throw new Error('Expected system and user messages');
  if (options.messages[0].role !== 'system' || options.messages[1].role !== 'user') throw new Error('Invalid message roles');
  const messages = options.messages.map(m => ({role:m.role,content:String(m.content)}));
  if (messages.some(m => m.content.length > 2000)) throw new Error('Model input too long');
  const max = Math.min(512, Math.max(1, Number(options.max_tokens) || 256));
  const payload = {model:GROQ_MODEL,messages,max_completion_tokens:max,reasoning_effort:'low',stream:false,temperature:0};
  if (options.json) payload.response_format = {type:'json_schema',json_schema:{name:'payment_proposal',strict:true,schema:{type:'object',additionalProperties:false,properties:{destination:{type:['string','null']},amountSol:{type:['number','null']},error:{type:['string','null']}},required:['destination','amountSol','error']}}};
  let res;
  try { res = await fetcher(URL,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env.GROQ_API_KEY},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)}); }
  catch { throw new Error('Groq request failed or timed out; no automatic retry'); }
  if (!res.ok) throw new Error('Groq HTTP '+res.status+'; no automatic retry');
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || data.choices[0].finish_reason !== 'stop') throw new Error('Groq returned incomplete output');
  if (content.length > 6000) throw new Error('Groq output exceeded local bound');
  if (options.json) {
    const p = JSON.parse(content);
    if (!p || Array.isArray(p) || Object.keys(p).some(k=>!['destination','amountSol','error'].includes(k))) throw new Error('Invalid proposal fields');
    if (p.error !== null) { if (typeof p.error !== 'string' || !p.error.trim()) throw new Error('Invalid interpretation error'); }
    else {
      if (typeof p.destination !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.destination)) throw new Error('Invalid proposal address');
      if (typeof p.amountSol !== 'number' || !Number.isFinite(p.amountSol) || p.amountSol<=0 || !Number.isSafeInteger(Math.round(p.amountSol*1e9))) throw new Error('Invalid proposal amount');
    }
  }
  return {response:content,model:data.model,usage:{prompt_tokens:data.usage?.prompt_tokens,completion_tokens:data.usage?.completion_tokens}};
}
