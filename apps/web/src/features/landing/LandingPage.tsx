import { AppBackground } from '../../components/glass/AppBackground';
import { CTASection } from '../../components/landing/CTASection';
import { Features } from '../../components/landing/Features';
import { Footer } from '../../components/landing/Footer';
import { Hero } from '../../components/landing/Hero';
import { HowItWorks } from '../../components/landing/HowItWorks';
import { Nav } from '../../components/landing/Nav';
import { Pricing } from '../../components/landing/Pricing';
import { Providers } from '../../components/landing/Providers';

export function LandingPage() {
  return (
    <>
      <AppBackground />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Nav />
        <main>
          <Hero />
          <Providers />
          <Features />
          <HowItWorks />
          <Pricing />
          <CTASection />
        </main>
        <Footer />
      </div>
    </>
  );
}
