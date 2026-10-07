// The platform-neutral encoder inside `qrcode` (no canvas, fs or Buffer). Its package entry pulls in
// Node renderers on native, so the client imports the core module directly.
declare module 'qrcode/lib/core/qrcode' {
  export { create } from 'qrcode';
}
