import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "الأكاديمية الأمريكية للاستشارات والتدريب | AACT",
  description:
    "منصة الأكاديمية الأمريكية للاستشارات والتدريب — دبلومات مهنية معتمدة، دكتوراه وماجستير مهني، اعتماد المستشارين والمدربين، مع مشرف ذكي بالذكاء الاصطناعي يرافقك صوتاً وكتابة",
  keywords: [
    "الأكاديمية الأمريكية",
    "استشارات",
    "تدريب",
    "دبلوم مهني",
    "دكتوراه مهنية",
    "ماجستير مهني",
    "اعتماد دولي",
    "AACT",
  ],
  authors: [{ name: "American Academy for Consulting and Training" }],
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/icon-192.png",
  },
  openGraph: {
    title: "الأكاديمية الأمريكية للاستشارات والتدريب",
    description: "بناء القيادات، صقل المهارات — منصة تعليمية بمشرف ذكي بالذكاء الاصطناعي",
    siteName: "AACT",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0f2b46",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&family=Tajawal:wght@400;500;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-background text-foreground font-cairo">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
