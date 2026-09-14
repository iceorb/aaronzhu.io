// Add places here. Coordinates are [longitude, latitude].
// `familiar` gives places that were more than a visit a little extra weight.
// Keep memories personal; dates and durations aren't part of this map.
window.travelPlaces = [
    {
        id: 'asia', name: 'Asia', bounds: [[72, -12], [148, 52]],
        places: [
            { id: 'china', name: 'China', mapId: '156', center: [104, 35], places: [
                { id: 'beijing', name: 'Beijing', coordinates: [116.4074, 39.9042] },
                { id: 'shanghai', name: 'Shanghai', coordinates: [121.4737, 31.2304], familiar: true },
                { id: 'shenzhen', name: 'Shenzhen', coordinates: [114.0579, 22.5431] },
                { id: 'taizhou', name: 'Taizhou', context: 'Zhejiang', coordinates: [121.4208, 28.6564], familiar: true }
            ] },
            { id: 'hong-kong', name: 'Hong Kong', mapId: '344', center: [114.1694, 22.3193], tiny: true },
            { id: 'indonesia', name: 'Indonesia', mapId: '360', center: [118, -3], places: [
                { id: 'bali', name: 'Bali', coordinates: [115.1889, -8.4095], kind: 'island' }
            ] },
            { id: 'japan', name: 'Japan', mapId: '392', center: [138, 37] },
            { id: 'singapore', name: 'Singapore', mapId: '702', center: [103.8198, 1.3521], tiny: true },
            { id: 'south-korea', name: 'South Korea', mapId: '410', center: [127.8, 36.4], places: [
                { id: 'seoul', name: 'Seoul', coordinates: [126.978, 37.5665], familiar: true }
            ] },
            { id: 'taiwan', name: 'Taiwan', mapId: '158', center: [120.96, 23.7] }
        ]
    },
    {
        id: 'europe', name: 'Europe', bounds: [[-13, 35], [21, 61]],
        places: [
            { id: 'austria', name: 'Austria', mapId: '040', center: [14.5, 47.5] },
            { id: 'germany', name: 'Germany', mapId: '276', center: [10.4, 51] },
            { id: 'ireland', name: 'Ireland', mapId: '372', center: [-8, 53.3] },
            { id: 'portugal', name: 'Portugal', mapId: '620', center: [-8.2, 39.5], bounds: [[-10, 36.5], [-5.5, 42.5]], places: [
                { id: 'porto', name: 'Porto', coordinates: [-8.6291, 41.1579] }
            ] },
            { id: 'switzerland', name: 'Switzerland', mapId: '756', center: [8.2, 46.8] },
            { id: 'united-kingdom', name: 'United Kingdom', mapId: '826', center: [-2.5, 54.5], places: [
                { id: 'northern-ireland', name: 'Northern Ireland', coordinates: [-6.7, 54.7], kind: 'region' }
            ] }
        ]
    },
    {
        id: 'north-america', name: 'North America', bounds: [[-140, 12], [-50, 65]],
        places: [
            { id: 'canada', name: 'Canada', mapId: '124', center: [-106, 57] },
            { id: 'mexico', name: 'Mexico', mapId: '484', center: [-102, 24] },
            { id: 'united-states', name: 'United States', mapId: '840', center: [-99, 39], bounds: [[-126, 24], [-66, 50]], places: [
                { id: 'madison', name: 'Madison', context: 'Wisconsin', coordinates: [-89.4012, 43.0731], familiar: true },
                { id: 'minnesota', name: 'Minnesota', coordinates: [-94.6859, 46.7296], kind: 'state', familiar: true },
                { id: 'new-york', name: 'New York', coordinates: [-74.006, 40.7128], familiar: true },
                { id: 'san-francisco', name: 'San Francisco', coordinates: [-122.4194, 37.7749], familiar: true },
                { id: 'seattle', name: 'Seattle', context: 'Washington', coordinates: [-122.3321, 47.6062] }
            ] }
        ]
    }
];
