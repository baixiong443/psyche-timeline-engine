declare const __PTE_VERSION__: string;

interface Window {
  SillyTavern?: {
    getContext: () => unknown;
  };
  toastr?: {
    info: (message: string, title?: string) => void;
    success: (message: string, title?: string) => void;
    warning: (message: string, title?: string) => void;
    error: (message: string, title?: string) => void;
  };
}
