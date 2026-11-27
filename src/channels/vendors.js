/**
 * Which company made a model?
 *
 * The model names that come back from the different services look all sorts
 * of different, but the user wants to see the maker, not the service. This
 * module turns a model name into a vendor, so the picker can group the
 * models by the company that built them.
 */

/**
 * The vendors we know about, in the order they are shown.
 *
 * `match` is a list of lower-case fragments. A model belongs to the first
 * vendor whose fragment appears in its name.
 */
export const VENDORS = [
  { id: 'deepseek', label: 'DeepSeek 深度求索', color: '#4D6BFE', match: ['deepseek', '深度求索'] },
  { id: 'zhipu', label: '智谱 GLM', color: '#3859FF', match: ['glm', 'zhipu', 'chatglm', '智谱'] },
  { id: 'moonshot', label: '月之暗面 Kimi', color: '#1F1F1F', match: ['kimi', 'moonshot'] },
  { id: 'minimax', label: 'MiniMax', color: '#E4007F', match: ['minimax'] },
  { id: 'doubao', label: '豆包 Doubao', color: '#3D6BFF', match: ['doubao', 'seed-', 'seed_'] },
  { id: 'qwen', label: '阿里 Qwen 通义', color: '#615CED', match: ['qwen', 'tongyi', '通义'] },
  { id: 'gemini', label: 'Google Gemini', color: '#4285F4', match: ['gemini'] },
  { id: 'anthropic', label: 'Anthropic Claude', color: '#D97757', match: ['claude'] },
  { id: 'openai', label: 'OpenAI', color: '#10A37F', match: ['gpt-', 'gpt4', 'gpt5', 'o1-', 'o3-', 'openai'] },
  { id: 'xai', label: 'xAI Grok', color: '#111111', match: ['grok'] },
  { id: 'xiaomi', label: '小米 MiMo', color: '#FF6900', match: ['mimo'] },
  { id: 'stepfun', label: '阶跃星辰 Step', color: '#1E6FFF', match: ['step-', 'stepfun'] },
  { id: 'tencent', label: '腾讯混元 Hunyuan', color: '#00A3FF', match: ['hunyuan', '混元'] },
  { id: 'baidu', label: '百度文心', color: '#4E6EF2', match: ['ernie', '文心'] },
  { id: 'youdao', label: '有道子模型', color: '#FF6A00', match: ['youdao', '子曰'] },
  { id: 'sensenova', label: '商汤日日新', color: '#00A6A6', match: ['senstnova', 'sensenova', '日日新'] },
  { id: 'iFlytek', label: '讯飞星火', color: '#2F6BFF', match: ['spark', '星火'] },
  { id: 'unknown', label: '其他厂商', color: '#8A938C', match: [] },
]

/**
 * The vendor of a model.
 *
 * @param {string} name the model id or the model name
 * @returns {{id: string, label: string, color: string}}
 */
export function vendorOf(name) {
  const text = String(name ?? '').toLowerCase()
  if (text.length === 0) return VENDORS[VENDORS.length - 1]
  for (const vendor of VENDORS) {
    if (vendor.id === 'unknown') continue
    if (vendor.match.some((fragment) => text.includes(fragment))) return vendor
  }
  return VENDORS[VENDORS.length - 1]
}

/**
 * The vendors of a list of models, in the order they should be shown.
 *
 * @param {Array<{vendor: string}>} models
 */
export function vendorOrder(models) {
  const seen = new Set()
  for (const model of models ?? []) {
    if (model?.vendor) seen.add(model.vendor)
  }
  return VENDORS.filter((vendor) => seen.has(vendor.id))
}
