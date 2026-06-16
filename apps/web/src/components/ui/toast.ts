export type ToastTone = 'ok' | 'error';
export interface ToastMsg {
  id: number;
  text: string;
  tone: ToastTone;
}

type Listener = (t: ToastMsg) => void;
const listeners = new Set<Listener>();
let seq = 0;

export function toast(text: string, tone: ToastTone = 'ok') {
  seq += 1;
  const msg: ToastMsg = { id: seq, text, tone };
  listeners.forEach((l) => {
    l(msg);
  });
}

export function subscribeToast(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
