import type { EntryRow } from './types'

// 巡查专项的持久化数据：与通用条目分开存放，重置业务条目不会抹掉「首次提交」凭证和待核台账。
const PATROL_DOMAIN_KEY = 'geohazard-patrol:patrol-domain'

export type FirstSubmission = {
  code: string
  rowId: number
  submittedAt: string
  outcome: 'accepted' | 'abnormal'
  inspector: string
  conclusionCode: string
  conclusionLabel: string
  ledgerEntryId: string
}

export type LedgerItem = {
  id: string
  source: 'patrol'
  refCode: string
  siteName: string
  inspector: string
  submittedAt: string
  conclusionLabel: string
  abnormal: boolean
  note: string
  checked: boolean
  checkedAt?: string
}

export type PatrolDomain = {
  firstSubmissions: FirstSubmission[]
  ledger: LedgerItem[]
}

const FALLBACK: PatrolDomain = { firstSubmissions: [], ledger: [] }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: PatrolDomain | null = null

function readDomain(): PatrolDomain {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(FALLBACK)
  }
  const raw = window.localStorage.getItem(PATROL_DOMAIN_KEY)
  if (!raw) {
    window.localStorage.setItem(PATROL_DOMAIN_KEY, JSON.stringify(FALLBACK))
    return clone(FALLBACK)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PatrolDomain>
    return {
      firstSubmissions: Array.isArray(parsed.firstSubmissions) ? parsed.firstSubmissions : [],
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
    }
  } catch {
    window.localStorage.setItem(PATROL_DOMAIN_KEY, JSON.stringify(FALLBACK))
    return clone(FALLBACK)
  }
}

export function patrolDomain(): PatrolDomain {
  if (cache === null) {
    cache = readDomain()
  }
  return cache
}

export function savePatrolDomain(next: PatrolDomain): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PATROL_DOMAIN_KEY, JSON.stringify(next))
  }
}

export function resetPatrolDomain(): void {
  savePatrolDomain(clone(FALLBACK))
}

// 巡查人单一数据源：名册与别名归一都收敛在这里，各处读取巡查人都经过 resolveInspector。
const INSPECTOR_ROSTER: { canonical: string; aliases: string[] }[] = [
  { canonical: '王建国', aliases: ['王队', '王建国队长', '建国'] },
  { canonical: '李秀英', aliases: ['李姐', '李巡'] },
  { canonical: '张海涛', aliases: ['小张', '海涛'] },
  { canonical: '赵群山', aliases: ['赵工', '群山'] },
]

const INSPECTOR_ALIAS_MAP = new Map<string, string>()
for (const member of INSPECTOR_ROSTER) {
  INSPECTOR_ALIAS_MAP.set(member.canonical, member.canonical)
  for (const alias of member.aliases) {
    INSPECTOR_ALIAS_MAP.set(alias, member.canonical)
  }
}

export function resolveInspector(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) {
    return ''
  }
  return INSPECTOR_ALIAS_MAP.get(name) ?? name
}

export function knownInspectors(): string[] {
  return INSPECTOR_ROSTER.map((member) => member.canonical)
}

export type LedgerRowRef = Pick<EntryRow, 'id'> & {
  巡查编号?: string | number
  所属隐患点?: string | number
  巡查人?: string | number
  巡查结论?: string | number
}
