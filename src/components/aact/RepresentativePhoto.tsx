'use client'

import { useState } from 'react'

type RepresentativePhotoProps = {
  src?: string | null
  alt: string
  fallback: string
  imgClassName?: string
  fallbackClassName?: string
}

export default function RepresentativePhoto({
  src,
  alt,
  fallback,
  imgClassName = 'h-full w-full object-cover',
  fallbackClassName = 'flex h-full w-full items-center justify-center text-6xl font-black text-[#f5f0e1]',
}: RepresentativePhotoProps) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return <span className={fallbackClassName}>{fallback}</span>
  }

  return <img src={src} alt={alt} className={imgClassName} onError={() => setFailed(true)} />
}
