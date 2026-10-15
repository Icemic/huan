/**
 * 协议版本号。
 *
 * 宿主与 UI 之间的所有可序列化契约都随此版本演进；
 * 具体命令/事件类型在迭代②按真实需求填充，此处仅作为版本化的起点。
 */
export const HARNESS_PROTOCOL_VERSION = 1 as const

export type HarnessProtocolVersion = typeof HARNESS_PROTOCOL_VERSION
