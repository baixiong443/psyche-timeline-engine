declare const __PTE_VERSION__: string;
import { PsycheTimelineController } from './runtime/controller';

async function install(): Promise<void> {
  const controller = PsycheTimelineController.create();
  if (!controller) {
    console.error('[Psyche Timeline Engine] SillyTavern context is unavailable.');
    return;
  }
  await controller.initialize();
  console.info(`[Psyche Timeline Engine] ${__PTE_VERSION__} loaded.`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void install(), { once: true });
} else {
  void install();
}
