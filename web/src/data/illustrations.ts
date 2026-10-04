export type LessonCategory = 'ADC' | 'PLL' | 'SerDes' | 'Circuits & Systems';

export interface Illustration {
  href: string;
  title: string;
  summary: string;
  thumb: 'pll-intro' | 'pipe-intro' | 'calibration' | 'pll' | 'sar' | 'inl' | 'err' | 'win' | 'fold' | 'ntf' | 'ti' | 'bits' | 'polar' | 'bode' | 'floor' | 'fom' | 'harm' | 'record' | 'repeat' | 'short' | 'train' | 'panel' | 'amplifier' | 'serdes' | 'cdr' | 'pcie';
  /** Whose site this is, for a page that is not on this one; it opens in a tab of its own. */
  external?: string;
  /** Public catalog label; assigned only after a lesson passes the editorial gate. */
  category?: LessonCategory;
}

export interface Topic {
  name: string;
  /** shown beside the heading, for anything that is here only for now */
  note?: string;
  items: Illustration[];
}

import { isPublicExternalHref, isPublicLessonPath } from './publication';

export const topics: Topic[] = [
  {
    name: 'Analog-to-digital converters',
    items: [
      {
        href: '/adc/aliasing-and-nyquist-zones/',
        title: 'Aliasing and Nyquist zones',
        summary: 'See where tones and harmonics land after sampling.',
        thumb: 'fold',
      },
      {
        href: '/adc/coherent-sampling/',
        title: 'Coherent sampling',
        summary: 'Measure spectral leakage and choose the right FFT window.',
        thumb: 'win',
      },
      {
        href: '/adc/how-long-a-record/',
        title: 'Choosing FFT record length',
        summary: 'Choose record length from frequency resolution and spur visibility.',
        thumb: 'record',
      },
      {
        href: '/adc/measurement-repeatability/',
        title: 'Measurement repeatability',
        summary: 'See how record length controls the spread of a reported SNDR value.',
        thumb: 'repeat',
      },
      {
        href: '/adc/short-records-near-nyquist/',
        title: 'Short records near Nyquist',
        summary: 'See how sparse phase and code coverage can produce convincing wrong metrics.',
        thumb: 'short',
      },
      {
        href: '/adc/binary-vs-redundant-sar/',
        title: 'Binary vs redundant SAR',
        summary: 'Explore SAR decisions, redundancy and weight calibration.',
        thumb: 'sar',
      },
      {
        href: '/adc/pipeline-adc/',
        title: 'Pipeline ADC',
        summary: 'Follow the input interval from stage to stage, and connect residue distortion to DNL and INL.',
        thumb: 'pipe-intro',
      },
      {
        href: '/adc/nonlinear-calibration/',
        title: 'Nonlinear calibration',
        summary: 'Learn an inverse, test on new data, and see what clipping and limited training cannot recover.',
        thumb: 'calibration',
      },
      {
        href: '/adc/how-much-training/',
        title: 'Choosing calibration record length',
        summary: 'Watch weight calibration overfit a short record, then generalise.',
        thumb: 'train',
      },
      {
        href: '/adc/inl-and-dnl/',
        title: 'INL and DNL',
        summary: 'Relate code widths and missing codes to static linearity.',
        thumb: 'inl',
      },
      {
        href: '/adc/what-sets-the-floor/',
        title: 'ADC noise, jitter, and distortion',
        summary: 'Weigh noise, resolution, jitter and distortion against each other.',
        thumb: 'floor',
      },
      {
        href: '/adc/analog-panel/',
        title: 'Analog output analysis panel',
        summary: 'Read one ADC capture through twelve synchronized diagnostic views.',
        thumb: 'panel',
      },
      {
        href: '/adc/reading-the-error/',
        title: 'Diagnosing ADC error',
        summary: 'Separate noise, distortion and jitter in the residual.',
        thumb: 'err',
      },
      {
        href: '/adc/pulling-the-harmonics-out/',
        title: 'Measuring harmonic distortion',
        summary: 'Measure distortion three ways and see whether they agree.',
        thumb: 'harm',
      },
      {
        href: '/adc/reading-the-bits/',
        title: 'Recovering SAR bit weights',
        summary: 'Read bit activity and recover the weights of a SAR ADC.',
        thumb: 'bits',
      },
      {
        href: '/adc/what-a-conversion-costs/',
        title: 'ADC energy and figures of merit',
        summary: 'Weigh figures of merit, physical walls and the units a datasheet uses.',
        thumb: 'fom',
      },
      {
        href: '/adc/oversampling-and-noise-shaping/',
        title: 'Oversampling and noise shaping',
        summary: 'Trade bandwidth for resolution and shape in-band noise.',
        thumb: 'ntf',
      },
      {
        href: '/adc/averaging-and-the-polar-spectrum/',
        title: 'Averaging and the polar spectrum',
        summary: 'Average repeated captures and inspect harmonic phase.',
        thumb: 'polar',
      },
      {
        href: '/adc/time-interleaved-adcs/',
        title: 'Time-interleaved ADCs',
        summary: 'See where channel mismatch, jitter and harmonics land in the spectrum.',
        thumb: 'ti',
      },
    ],
  },
];

/** Clocking, amplifier lessons and a selected external analysis tool. */
export const related: Topic = {
  name: 'More to explore',
  items: [
    {
      href: '/pll/introduction/',
      title: 'PLL introduction',
      summary: 'Watch phase feedback lock an oscillator; explore loop speed, damping and the integral path.',
      thumb: 'pll-intro',
      category: 'PLL',
    },
    {
      href: '/pll/integer-vs-fractional/',
      title: 'Integer-N vs fractional-N',
      summary: 'See why integer-N lands on a channel grid and fractional-N does not.',
      thumb: 'pll',
      category: 'PLL',
    },
    {
      href: '/amplifiers/open-loop-and-closed-loop/',
      title: 'Open-loop to closed-loop',
      summary: 'Use feedback to trade gain for bandwidth in a single-pole amplifier.',
      thumb: 'amplifier',
      category: 'Circuits & Systems',
    },
    {
      href: '/serdes/112g-pam4-link/',
      title: '112G PAM4 SerDes link',
      summary: 'Follow PAM4 symbols through a 3-D chip-to-chip link and equalize the eye.',
      thumb: 'serdes',
      category: 'SerDes',
    },
    {
      href: '/serdes/clock-and-data-recovery/',
      title: 'Clock and data recovery',
      summary: 'A guided tour from the ground up: why a receiver must find its own clock, how a CDR steers by the data edges, and what it cannot follow.',
      thumb: 'cdr',
      category: 'SerDes',
    },
    {
      href: '/serdes/pci-express/',
      title: 'PCI Express',
      summary: 'A guided tour of a PCIe link in 3-D: lanes and generations, packets in their envelopes, resends after an error, and credits that keep the receiver from overflowing.',
      thumb: 'pcie',
      category: 'SerDes',
    },
    {
      href: 'https://many-question.github.io/bode-sketch/',
      title: 'Bode plots & stability',
      summary: 'Explore poles, zeros and responses; verify marginal stability independently.',
      thumb: 'bode',
      external: 'many-question.github.io',
      category: 'Circuits & Systems',
    },
  ],
};

/** The small, reviewed set shown on the public home page. */
export const featuredLessons: Illustration[] = [
  ...topics
    .flatMap((topic) => topic.items)
    .filter((item) => isPublicLessonPath(item.href))
    .map((item) => ({ ...item, category: 'ADC' as const })),
  ...related.items
    .filter((item) => isPublicLessonPath(item.href) || isPublicExternalHref(item.href))
    .map((item) => ({
      ...item,
      category: item.category ?? 'Circuits & Systems' as const,
    })),
];
