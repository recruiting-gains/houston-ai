// Best-effort Houston neighborhood/area derivation from venue names, addresses and ZIP codes.
// Returns null when unsure: a wrong area is worse than no area.

const KEYWORDS = [
    [/discovery green|george r\.? ?brown|toyota center|daikin park|minute maid|market square|jones hall|wortham|hobby center|alley theatre|theater district|main street square|avenida houston|post houston|allen.?s landing|julia ideson|central library|jesse h\.? jones|downtown/i, 'Downtown'],
    [/hermann park|miller outdoor|houston zoo|mcgovern centennial|museum of fine arts|mfah|menil|rothko|camh|contemporary arts museum|holocaust museum|natural science|hmns|children.?s museum|museum district|clayton library|health museum/i, 'Museum District'],
    [/memorial park|arboretum|cullen running|eastern glades|clay family/i, 'Memorial Park'],
    [/buffalo bayou|cistern|lost lake|waugh|sabine|dunlavy|tapley/i, 'Buffalo Bayou Park'],
    [/levy park|upper kirby/i, 'Upper Kirby'],
    [/space center|nasa|clear lake|kemah/i, 'Clear Lake / NASA'],
    [/tdecu|fertitta center|university of houston|carl lewis|cougar|emancipation park|project row houses|third ward/i, 'Third Ward'],
    [/rice stadium|rice university|tudor fieldhouse|reckling|holloway field|rice village|west university/i, 'Rice / West U'],
    [/sawyer yards|silver street|washington ave|rice military|spring street studios/i, 'Washington Ave / Sawyer Yards'],
    [/heights|white oak|19th st/i, 'The Heights'],
    [/midtown|bagby|elizabeth baldwin|baldwin park|bell park|wheeler/i, 'Midtown'],
    [/east end|eado|navigation|eastwood|magnolia park|second ward|guadalupe plaza|tony marron/i, 'East End / EaDo'],
    [/montrose/i, 'Montrose'],
    [/galleria|uptown|post oak|gerald d\.? hines waterwall/i, 'Galleria / Uptown'],
    [/nrg park|nrg stadium|astrodome/i, 'NRG Park'],
    [/medical center|texas medical/i, 'Medical Center'],
    [/river oaks/i, 'River Oaks'],
    [/garden oaks|oak forest/i, 'Oak Forest / Garden Oaks'],
    [/spring branch/i, 'Spring Branch'],
    [/alief/i, 'Alief'],
    [/asiatown|chinatown|bellaire/i, 'Bellaire / Asiatown'],
    [/meyerland|stella link/i, 'Meyerland'],
    [/fifth ward/i, 'Fifth Ward'],
    [/westchase/i, 'Westchase'],
    [/acres homes/i, 'Acres Homes'],
    [/kashmere/i, 'Kashmere Gardens'],
    [/park place/i, 'Park Place'],
];

// Houston Public Library branches (LibCal "campus") -> area.
const HPL_BRANCHES = [
    [/african american library|gregory school/i, 'Fourth Ward'],
    [/flores/i, 'East End / EaDo'],
    [/stanaker/i, 'East End / EaDo'],
    [/freed.?montrose/i, 'Montrose'],
    [/looscan/i, 'River Oaks'],
    [/heights/i, 'The Heights'],
    [/oak forest|collier/i, 'Oak Forest / Garden Oaks'],
    [/hillendahl|\bring\b/i, 'Spring Branch'],
    [/henington.?alief|alief/i, 'Alief'],
    [/robinson.?westchase/i, 'Westchase'],
    [/jungman/i, 'Galleria / Uptown'],
    [/mcgovern.?stella link/i, 'Meyerland'],
    [/smith|young/i, 'Third Ward'],
    [/acres homes/i, 'Acres Homes'],
    [/kashmere/i, 'Kashmere Gardens'],
    [/park place/i, 'Park Place'],
    [/carnegie|moody/i, 'Near Northside'],
    [/fifth ward|wheatley/i, 'Fifth Ward'],
];

const ZIPS = {
    77002: 'Downtown', 77010: 'Downtown', 77003: 'East End / EaDo', 77011: 'East End / EaDo', 77023: 'East End / EaDo', 77012: 'East End / EaDo',
    77004: 'Museum District', 77030: 'Medical Center', 77005: 'Rice / West U', 77006: 'Montrose', 77019: 'River Oaks', 77098: 'Upper Kirby',
    77027: 'Upper Kirby', 77046: 'Upper Kirby', 77007: 'Washington Ave / Sawyer Yards', 77008: 'The Heights', 77009: 'Near Northside',
    77020: 'Fifth Ward', 77021: 'Third Ward', 77024: 'Memorial', 77056: 'Galleria / Uptown', 77057: 'Galleria / Uptown', 77058: 'Clear Lake / NASA',
    77059: 'Clear Lake / NASA', 77062: 'Clear Lake / NASA', 77054: 'NRG Park', 77096: 'Meyerland', 77401: 'Bellaire / Asiatown', 77036: 'Bellaire / Asiatown',
    77055: 'Spring Branch', 77080: 'Spring Branch', 77018: 'Oak Forest / Garden Oaks', 77092: 'Oak Forest / Garden Oaks', 77099: 'Alief', 77072: 'Alief',
    77042: 'Westchase', 77017: 'Park Place', 77026: 'Kashmere Gardens', 77091: 'Acres Homes', 77088: 'Acres Homes', 77079: 'Energy Corridor', 77077: 'Energy Corridor',
};

export const AREAS = [...new Set([...KEYWORDS.map((k) => k[1]), ...HPL_BRANCHES.map((k) => k[1]), ...Object.values(ZIPS)])].sort();

export function areaFromText(text) {
    if (!text) return null;
    for (const [re, area] of KEYWORDS) if (re.test(text)) return area;
    return null;
}

export function areaFromZip(zip) {
    const m = String(zip || '').match(/\b(77\d{3})\b/);
    return m ? ZIPS[m[1]] || null : null;
}

export function areaFromHplBranch(branch) {
    if (!branch) return null;
    if (/central library|jesse h\.? jones|julia ideson/i.test(branch)) return 'Downtown';
    for (const [re, area] of HPL_BRANCHES) if (re.test(branch)) return area;
    return null;
}
