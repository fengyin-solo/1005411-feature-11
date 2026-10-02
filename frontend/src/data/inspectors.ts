/**
 * 巡查人花名册：巡查人信息的唯一数据源。
 *
 * 一次巡线回来十几条记录可能分散在列表、结果回显、避险场所台账等多处读取巡查人，
 * 全部必须经由 resolveInspector 取同一份，禁止各页面自己 trim/兜底。
 */

export type Inspector = {
  name: string
  team: string
  phone: string
}

// 花名册是唯一权威来源；这里只维护一份，新增/改名只改这里。
export const INSPECTORS: Inspector[] = [
  { name: '张志强', team: '群测群防一组', phone: '13800000011' },
  { name: '李秀英', team: '群测群防一组', phone: '13800000012' },
  { name: '王海涛', team: '群测群防二组', phone: '13800000013' },
  { name: '陈桂兰', team: '群测群防二组', phone: '13800000014' },
  { name: '赵建国', team: '群测群防三组', phone: '13800000015' },
  { name: '刘春燕', team: '群测群防三组', phone: '13800000016' },
]

const BY_NAME = new Map(INSPECTORS.map((person) => [person.name, person]))
// 常见口语写法归并到花名册，保证“多处读取取同一份”。
const ALIAS: Record<string, string> = {
  老张: '张志强',
  志强: '张志强',
  海: '王海涛',
}

/** 读取巡查人：去空白、口语写法归一；花名册查不到时按规范姓名原样返回。 */
export function resolveInspector(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return ''
  }
  const canonical = ALIAS[text] ?? text
  return BY_NAME.has(canonical) ? canonical : canonical
}

export function isKnownInspector(raw: unknown): boolean {
  const name = resolveInspector(raw)
  return name !== '' && BY_NAME.has(name)
}

/** 取巡查人联系电话；未入花名册时返回空串，台账多处读取保持同一份。 */
export function inspectorPhone(raw: unknown): string {
  return BY_NAME.get(resolveInspector(raw))?.phone ?? ''
}
