import { toast as sonnerToast } from 'sonner'

type ToastOptions = {
  description?: string
  duration?: number
  action?: { label: string; onClick: () => void }
}

export const toast = {
  success(message: string, opts?: ToastOptions) {
    sonnerToast.success(message, { duration: 4000, ...opts })
  },
  warning(message: string, opts?: ToastOptions) {
    sonnerToast.warning(message, { duration: 6000, ...opts })
  },
  error(message: string, opts?: ToastOptions) {
    sonnerToast.error(message, { duration: Infinity, ...opts })
  },
  info(message: string, opts?: ToastOptions) {
    sonnerToast.info(message, { duration: 4000, ...opts })
  },
  loading(message: string): string | number {
    return sonnerToast.loading(message)
  },
  dismiss(id?: string | number) {
    sonnerToast.dismiss(id)
  }
}
