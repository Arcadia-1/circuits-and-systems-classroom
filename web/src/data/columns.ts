/** Courses published on other sites, listed under External Links below the lessons on the home page. */
export interface Column {
  href: string;
  site: string;
  title: string;
  summary: string;
  chapters: number;
  /** Optional label after the site name; defaults to `${chapters} lessons`. */
  meta?: string;
  /** Part titles in course order. */
  parts: string[];
  /** Cover image from the course's own page, kept in public/external/. */
  image: { src: string; width: number; height: number };
}

export const columns: Column[] = [
  {
    href: 'https://icdesign.com/zhuanlans/51',
    site: 'icdesign.com',
    title: 'The Mixed-Signal IC Designer’s Journey: Starting with the SAR ADC (in Chinese)',
    summary:
      'The SAR ADC as the bridge between analog and digital: ADC fundamentals, specifications and spectrum simulation; a 4-bit ideal model; the theory and practice of the capacitor array and its switching, asynchronous SAR logic, the dynamic comparator and the bootstrapped switch; then real design issues such as redundancy, top- and bottom-plate sampling, PVT and metastability.',
    chapters: 34,
    parts: ['ADC basics', '4-bit model', 'Circuit blocks', 'Specs and upgrades', 'The analog signal chain'],
    image: { src: '/external/icdesign-sar-adc.jpg', width: 360, height: 303 },
  },
  {
    href: 'https://icdesign.com/zhuanlan-ai',
    site: 'icdesign.com',
    title: 'Postmodern Analog IC Course: AI-Assisted Video Series (in Chinese)',
    summary:
      'Making abstract analog circuits visual through short, continuously updated AI-animated videos: Razavi analog fundamentals (MOS physics, single-stage and differential amplifiers, current mirrors, frequency response) alongside frontier topics in ΔΣ and high-speed ADCs, PLLs, 200G+ SerDes, RF, and recent ISSCC papers.',
    chapters: 46,
    meta: '46+ videos · ongoing',
    parts: ['AI-assisted IC design', 'Razavi fundamentals', 'ΔΣ & high-speed ADCs', 'PLLs & timing', 'SerDes, RF & ISSCC'],
    image: { src: '/external/icdesign-postmodern-analog.jpg', width: 360, height: 303 },
  },
];
