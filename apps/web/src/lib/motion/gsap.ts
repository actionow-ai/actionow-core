import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { DUR, EASE } from './tokens';

gsap.registerPlugin(useGSAP, ScrollTrigger);
gsap.defaults({ ease: EASE.out, duration: DUR.slow });

export { gsap, ScrollTrigger, useGSAP };
