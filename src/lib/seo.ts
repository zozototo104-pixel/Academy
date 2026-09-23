import type { Metadata } from 'next'

export const SITE_NAME = 'الأكاديمية الأمريكية للاستشارات والتدريب | AACT'
export const SITE_DESCRIPTION = 'منصة الأكاديمية الأمريكية للاستشارات والتدريب — دبلومات مهنية، ماجستير ودكتوراه مهنية، اعتماد مستشارين ومدربين، وشهادات قابلة للتحقق إلكترونياً.'

export function siteUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') || 'https://aactacademy.com').replace(/\/$/, '')
}

export function absoluteUrl(path = '/') {
  const base = siteUrl()
  const clean = path.startsWith('/') ? path : `/${path}`
  return `${base}${clean}`
}

export const PUBLIC_SEO_ROUTES = [
  { path: '/', title: 'الأكاديمية الأمريكية للاستشارات والتدريب', description: SITE_DESCRIPTION, priority: 1 },
  { path: '/programs', title: 'البرامج والخدمات المهنية', description: 'استعرض برامج الدبلوم والماجستير والدكتوراه المهنية والاعتمادات والخدمات التدريبية في AACT.', priority: 0.95 },
  { path: '/apply', title: 'طلب الالتحاق', description: 'قدّم طلب الالتحاق أو طلب خدمة مهنية عبر منصة AACT.', priority: 0.85 },
  { path: '/verify', title: 'التحقق من الشهادات', description: 'تحقق من صحة شهادات AACT عبر الرقم التسلسلي أو رمز QR وملف JSON قابل للتحقق.', priority: 0.85 },
  { path: '/certificates', title: 'التحقق من الشهادات', description: 'صفحة التحقق العامة من شهادات الأكاديمية الأمريكية للاستشارات والتدريب.', priority: 0.8 },
  { path: '/directory', title: 'دليل الاعتمادات', description: 'دليل الاعتمادات والعضويات والجهات المعتمدة لدى AACT.', priority: 0.7 },
  { path: '/about', title: 'من نحن', description: 'تعرف على الأكاديمية الأمريكية للاستشارات والتدريب ورسالتها وبرامجها.', priority: 0.7 },
  { path: '/contact', title: 'تواصل معنا', description: 'تواصل مع فريق AACT للاستفسارات وطلبات الدعم.', priority: 0.65 },
]

export const PRIVATE_ROUTE_PREFIXES = ['/admin', '/dashboard', '/supervisor', '/login', '/auth', '/unit', '/exam', '/chat']

export function isPrivateSeoPath(pathname: string) {
  return PRIVATE_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function seoForPath(pathname: string): Metadata {
  const cleanPath = pathname || '/'
  const matched = PUBLIC_SEO_ROUTES.find((r) => r.path === cleanPath)
  const isProgramDetail = cleanPath.startsWith('/programs/')
  const title = matched?.title || (isProgramDetail ? 'تفاصيل البرنامج المهني' : SITE_NAME)
  const description = matched?.description || (isProgramDetail ? 'تفاصيل برنامج مهني لدى الأكاديمية الأمريكية للاستشارات والتدريب، مع معلومات الالتحاق والتحقق والخدمات التعليمية.' : SITE_DESCRIPTION)
  const noindex = isPrivateSeoPath(cleanPath)

  return {
    title,
    description,
    alternates: { canonical: cleanPath },
    robots: noindex ? { index: false, follow: false, nocache: true } : { index: true, follow: true },
    openGraph: {
      title,
      description,
      url: absoluteUrl(cleanPath),
      siteName: SITE_NAME,
      type: 'website',
      locale: 'ar',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  }
}

export function organizationJsonLd() {
  const base = siteUrl()
  return {
    '@context': 'https://schema.org',
    '@type': 'EducationalOrganization',
    name: 'الأكاديمية الأمريكية للاستشارات والتدريب',
    alternateName: 'AACT',
    url: base,
    logo: absoluteUrl('/icon-512.png'),
    sameAs: [base],
    description: SITE_DESCRIPTION,
    hasCredential: {
      '@type': 'EducationalOccupationalCredential',
      name: 'AACT Verifiable Certificates',
      credentialCategory: 'Professional Certificate',
      url: absoluteUrl('/verify'),
    },
  }
}

export function websiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: siteUrl(),
    inLanguage: 'ar',
    potentialAction: {
      '@type': 'SearchAction',
      target: `${absoluteUrl('/programs')}?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  }
}
