import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from 'react-hot-toast';
import { NavBar } from '../components/NavBar';

export const metadata: Metadata = {
  title: "Universal Privacy Hook - Professional DeFi Trading",
  description: "Private swaps powered by Fully Homomorphic Encryption on Uniswap V4",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`antialiased`}>
        <div className="fixed inset-0 bg-cover bg-center bg-no-repeat" style={{ backgroundImage: "url('/BackgroundImage.png')" }}></div>
        
        {/* Professional App Shell */}
        <Providers>
          <div className="flex flex-col min-h-screen">
            {/* Top Navigation Bar */}
            <nav className="sticky top-0 z-50 w-full border-b border-gray-200 bg-white/90 backdrop-blur-md shadow-sm">
              <div className="container mx-auto px-4">
                <div className="flex h-16 items-center justify-between">
                  <NavBar />
                </div>
              </div>
            </nav>
            
            {/* Main Content */}
            <main className="flex-1 container mx-auto px-4 py-8">
              {children}
            </main>
          </div>
        </Providers>
        <Toaster 
          position="bottom-right"
          toastOptions={{
            duration: 5000,
            style: {
              background: '#ffffff',
              color: '#111827',
              padding: '16px',
              borderRadius: '8px',
              fontSize: '14px',
              border: '1px solid #e5e7eb',
              boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
            },
            success: {
              duration: 4000,
              iconTheme: {
                primary: '#10b981',
                secondary: '#fff',
              },
            },
            error: {
              duration: 4000,
              iconTheme: {
                primary: '#f43f5e',
                secondary: '#fff',
              },
            },
          }}
        />
      </body>
    </html>
  );
}
