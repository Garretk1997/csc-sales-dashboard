// worker/src/calendars.ts
//
// Calendar roster for the appointments sweep (Stream 3). Mirrors config.ts:
// human-maintained names/roles, IDs verified read-only 2026-07-01 (see
// DESIGN-stream3-appointments.md and SPIKE-stream3-appointments.md).
// role drives which sealed metric a calendar feeds; 'exclude' calendars
// (busy-blocks) are never fetched.

export type CalendarRole = 'setter' | 'closer' | 'discovery' | 'other'

export const CALENDARS: { id: string; name: string; role: CalendarRole }[] = [
  { id: 'UCLiMliOC031tBNCIwoM', name: 'Capital Stack 1-on-1', role: 'closer' },
  { id: 'SEBOg7dYcjuTcddeHXea', name: 'Capital Stack Strategy Call', role: 'discovery' },
  { id: 'd2HDmtzG0wCiqWMeFrds', name: 'Book 1-on-1 (Setters)', role: 'setter' },
  { id: '5h0vdmn85v3Jz3Dtnqlz', name: 'Jinnie Do - Strategy Call', role: 'discovery' },
  { id: 'X6pkh6ABh4q9LwidqrUu', name: 'CS Engagement Profile 1-on-1', role: 'other' },
  { id: 'fAvNmgVsYU0phCdSEqKa', name: 'Leticia Kepka capital stack call', role: 'other' },
  { id: 'dKqEtBrVNnsepxHzBRID', name: 'CS Intro with Marcus', role: 'other' },
  { id: 'HWQ85pzELckLDNB9dVBl', name: 'CSC - Strategy Call', role: 'discovery' },
  { id: 'UdtMa5slvvO6sJHn6ZGG', name: 'Kaylee Stevens - CSC Strategy Call', role: 'discovery' },
  { id: 'Q5JqZp8D14hSjxG8AqRz', name: 'CS Follow-up call', role: 'other' },
  // 'FN1aqzOK32FmdPKqmoUu' BLOCK and 'vzYmoC2CL9wAFnHbqbG6' Discovery Call (empty) excluded.
]

// Historical name fallbacks: bookers deleted in the 2026-06-16 user consolidation
// no longer resolve via /users/ or the roster-synced users table. Names captured
// from the bundle's context/15 roster so their past bookings stay attributable.
export const HISTORICAL_NAMES: Record<string, string> = {
  kgp7haMio0YQjo8chRWX: 'Kaitlyn Tran', QRueoTGzZEUH89KQaZo1: 'Kristin LaBruce',
  r9hrYqC3n7EEvxHuSaBq: 'Taylor Victoria', zweBK8uZEhkPfHEYP8be: 'Lilia Farshifarid',
  cCPcQPV5qHWxgcZuY1UC: 'Destiny Schlink', Qpi3NRHLg9oX8YwHV18T: 'Jennie Gjini',
  njPc888fB8O3Ckmnzmqr: 'Shone Koo', ZLklFEA4eBO8AFtmUA4H: 'Ashley Geldenhuys',
  ze6TGYyUhMziz5RhyRZw: 'McKenna Stewart', GzDF4vSACab0QQ45M7Xd: 'Sarah Neuser',
  G9Ib1W2h6bOoEduvSUnI: 'Jennifer Brito', '5dz02Ixj5UJQA9rekEro': 'Alliah Rogers',
  pVZKlekSvqNBeMr0pRN3: 'Kelci Wolter', NgUE4c5Fahb7ufbPxd2U: 'Leila Bahrambahri',
  '97TmQktsF4wpUzCZ3XS2': 'Amanda Hollyday', '8dTXHTsL7UFYGUcbCfSp': 'Shugi Yasin',
  ZW5bXnuiDrELu8EBcgOO: 'Sarah Mills', WdCign2LPrJPFHVnqLh8: 'Zainab Gondal',
  '2jUR37albX59Y1e4rIIl': 'Elise Odom', '28A1MXkLapMxmrPXT31e': 'Jackie Drazan',
  cxygnYMsU2nRZweBb5EK: 'Natalia Smith', WSxgSPLIui8vJq0QBe70: 'Jasnoor Chehal',
  '2hziFRTudRniRu4tP4Pl': 'Tamken Adeel', F92GNKAOJLnqRenAEHpr: 'Sarah Pennell',
  CWQAd2zeexFoBFhFM1JR: 'Julienne Los Banez', YFotS9sISW5Kzs880EGX: 'Nayrelis Pantoja Santos',
  '04q1UhU3cIyCOPi69gJp': 'Huda Zen', jJ1PaRcyaNeJGGqHUh6M: 'Alexis Parish',
  CoehnPrWasBk3UkDm7Ps: 'Simran Gill', a5KnhJ92ajuOFGxPEZB6: 'Lillian Coffman',
  sOsVrbnHBW91SfgaLxjE: 'Annalise Werner', '0WcvDFSNXrHbvil0BNn1': 'Kulwinder Hunjan',
  w0yVeY4DzKtKXG3VKw8v: 'Natasha Naples', '8h3JNbepBCfEGoZQRqMu': 'Lloyce Lartey',
  RsJ1O1N75b3RbIr7pE4v: 'Patrice Forbes', eVbmRxpCppKtcPaRzcPA: 'Henesse Lopez',
  '5ilBLelExHZpbcT8p5NF': 'Fleur Sykes', '3WXE915c6ab7MBTecCl3': 'Samantha Raleigh',
  pOhmm7G74O0fwxyK1fqr: 'Camille Starcevich', WgvxBrZeykNu3GeohSJj: 'Kavalyn Teethas',
  '7QWx0BpYdnylG7plJuGB': 'Jessica Bedoya', YdAATq45S9MjwlcKLYVM: 'Ally Wise',
  UuQM0jbFS7PeBsy6uagx: 'Elizabeth Muntaner', UdGPgv0PYDW4HbR4uZLW: 'Bree Rios',
  nf0C1eNF1N58OV2hLDeY: 'Amanda Fogel', '2xfEavZ87FOtzxrRSRnc': 'Aleksandra Pecyna',
  Y1R8VHJwq9DwY79u4NM1: 'Maria Sanchez Morales', pifiwGc6ntIo9Fn8osN5: 'McCall Bronson',
  ARPyME65VIep3bHy2usZ: 'Isabella Cadwell', geL3AdUYAEfCB61wCgc1: 'Sasha Horhul',
  slQd7Eb4lh4i0P2JruBO: 'Melissa Donnelly', '25a5BcAhLTjDZJwLyjwf': 'Callie Hutchins',
  bRTkWlMTYousLq5V57na: 'Jinnie Do', '5jAOHyyilmVJAYamp9DA': 'Kaylee Stevens',
  ai1pAqxWWSQl38ULLZXr: 'Kylie Hill', '1YV0PBtH3GP5X7qRUHrf': 'Maja G',
  DUv8tAVOGQHKuIG0VYfl: 'Marvi Boyce', LSiodfEFrYgv9wcnuX4e: 'Shawna Tracy',
  '2CJ8bykllLbhawCOGUlA': 'Ashley Clark', ICrJem00x98glsD1ZLZU: 'Jack Bentley',
  L8xwHitrRDFPfooLgmND: 'Sidney Weigel', fwxrtRtW2NBMCMPvDJV8: 'Mackenzie Story',
}
