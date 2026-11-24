import { readonly, ref } from 'vue';

const pointed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

// Whether the + that starts an agent is pulsing, after Get started's Show.
export const launchPointed = readonly(pointed);

export function pointAtLaunch(): void {
  clearTimeout(timer);
  pointed.value = false;
  // A frame off first, so pressing Show again restarts the pulse.
  requestAnimationFrame(() => {
    pointed.value = true;
    timer = setTimeout(() => { pointed.value = false; }, 2_800);
  });
}
