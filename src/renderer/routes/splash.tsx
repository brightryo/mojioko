import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { SPLASH_DURATION_MS, SPLASH_FADEOUT_MS } from '../../shared/constants'
import { APP_NAME } from '../../shared/app-info'

/**
 * Splash screen.
 * Shows splash.png for SPLASH_DURATION_MS, fades out, then navigates to /step1.
 * No title bar, breadcrumb, or footer — full-bleed overlay.
 */
export default function SplashRoute() {
  const navigate = useNavigate()
  const hasNavigated = useRef(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!hasNavigated.current) {
        hasNavigated.current = true
        navigate('/step1', { replace: true })
      }
    }, SPLASH_DURATION_MS + SPLASH_FADEOUT_MS)

    return () => clearTimeout(timer)
  }, [navigate])

  return (
    <motion.div
      className="flex h-full w-full flex-col items-center justify-center bg-surface-0"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SPLASH_FADEOUT_MS / 1000, ease: 'easeOut' }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="flex flex-col items-center gap-4"
      >
        {/* Splash image — served from resources/ via Vite publicDir.
            Relative path './splash/...' (not '/splash/...') so it also works
            in packaged mode where the renderer's file:// origin makes absolute
            '/'-rooted URLs resolve to the file-system root. */}
        <img
          src="./splash/splash.png"
          alt={APP_NAME}
          className="max-h-[180px] w-auto object-contain"
          draggable={false}
        />
      </motion.div>
    </motion.div>
  )
}
