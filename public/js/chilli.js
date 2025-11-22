const SUPABASE_URL = 'https://dcljhabgelsstbffmlou.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjbGpoYWJnZWxzc3RiZmZtbG91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3MDc3OTEsImV4cCI6MjA3OTI4Mzc5MX0.HJe6hZ5Wc15zkR9vqlyNTpP_NUnABYCeq9EqJBymVU0';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const PYTHON_API_URL = "http://localhost:8000"; // Ensure your Python server is running here

// --- MAP SETUP ---
const map = L.map('map', { zoomControl: false }).setView([0, 0], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(map);

// --- LAYERS ---
let routeLayerGroup = L.featureGroup().addTo(map); // Holds the colored segments
let myMarker = null;
let markers = { src: null, dst: null };
let teammates = {};

// --- USER STATE ---
const randomHue = Math.floor(Math.random() * 360);
let me = {
    id: 'u_' + Math.floor(Math.random() * 999999),
    name: 'Rider',
    color: `hsl(${randomHue}, 100%, 60%)`
};

let session = null;
let myRoute = [];
let ghostTimer = null;
let metrics = { speed: 0, dist: 0, time: 0, start: null, cal: 0 };

// --- UI INTERACTION ---
document.getElementById('toggle-controls').addEventListener('click', () => {
    document.getElementById('controlsPanel').classList.toggle('open');
});

// --- AUTO-LOCATE ---
window.onload = function () {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            map.setView([lat, lng], 15);
            document.getElementById('src').value = `${lat.toFixed(4)},${lng.toFixed(4)}`;

            if (markers.src) map.removeLayer(markers.src);
            markers.src = L.marker([lat, lng]).addTo(map).bindPopup("You").openPopup();
            updateMyMarker(lat, lng);
        }, err => {
            console.log("GPS Error");
            map.setView([20, 78], 4);
        }, { enableHighAccuracy: true });
    }
};

// --- MAP CLICKS ---
let pickMode = null;
map.on('click', e => {
    if (!pickMode) return;
    const { lat, lng } = e.latlng;

    if (pickMode === 'src') {
        document.getElementById('src').value = `${lat.toFixed(4)},${lng.toFixed(4)}`;
        if (markers.src) map.removeLayer(markers.src);
        markers.src = L.marker([lat, lng]).addTo(map).bindPopup("Start");
    } else {
        setDestination(lat, lng, "Custom Dest");
        if (session) syncDestination(lat, lng);
    }
    pickMode = null;
    document.getElementById('map').style.cursor = 'grab';
});

function setMode(m) {
    pickMode = m;
    document.getElementById('map').style.cursor = 'crosshair';
}

function setDestination(lat, lng, label) {
    document.getElementById('dst').value = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (markers.dst) map.removeLayer(markers.dst);
    markers.dst = L.marker([lat, lng]).addTo(map).bindPopup(label).openPopup();
}

// --- SESSION & SUPABASE ---
async function createSession() {
    const id = Math.random().toString(36).substring(2, 6).toUpperCase();
    document.getElementById('sessId').value = id;
    joinSession();
}

async function joinSession() {
    const id = document.getElementById('sessId').value;
    if (!id) return alert("Enter Session ID");
    session = id;
    me.name = document.getElementById('username').value;

    document.getElementById('tmPanel').style.display = 'block';
    document.getElementById('status').innerHTML = `Online: <span style="color:#2ecc71">${id}</span>`;

    supabase.channel('loc_' + id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'locations', filter: `session_id=eq.${id}` },
            payload => handleTeammateUpdate(payload.new))
        .subscribe();

    supabase.channel('sess_' + id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${id}` },
            payload => {
                if (payload.new?.route?.type === 'dest_sync') setDestination(payload.new.route.lat, payload.new.route.lng, "Host Dest");
            })
        .subscribe();

    const { data: existingUsers } = await supabase.from('locations').select('*').eq('session_id', id);
    if (existingUsers) {
        existingUsers.forEach(u => {
            if (u.user_id !== me.id) handleTeammateUpdate(u);
        });
    }

    const { data: sessData } = await supabase.from('sessions').select('route').eq('id', id).single();
    if (sessData?.route?.type === 'dest_sync') setDestination(sessData.route.lat, sessData.route.lng, "Host Dest");
}

function handleTeammateUpdate(data) {
    if (data.user_id === me.id) return;

    let tm = teammates[data.user_id];
    if (!tm) {
        const el = document.createElement('div');
        el.className = 'tm-row';
        el.id = `tm-li-${data.user_id}`;
        el.innerHTML = `<div class="color-dot" style="background:${data.color}; box-shadow: 0 0 5px ${data.color}"></div> ${data.username}`;
        document.getElementById('tmList').appendChild(el);

        const icon = L.divIcon({
            className: 'tm-icon',
            html: `<div style="background:${data.color}; width:100%; height:100%; border-radius:50%"></div>`
        });
        const marker = L.marker([data.lat, data.lon], { icon }).addTo(map).bindPopup(data.username);
        tm = { marker, polyline: null, color: data.color };
        teammates[data.user_id] = tm;
    }

    tm.marker.setLatLng([data.lat, data.lon]);

    // Teammates show as simple dotted lines
    if (data.route_coords && Array.isArray(data.route_coords) && data.route_coords.length > 0) {
        if (tm.polyline) map.removeLayer(tm.polyline);
        tm.polyline = L.polyline(data.route_coords, {
            color: data.color,
            weight: 4,
            opacity: 0.5,
            dashArray: '5, 10'
        }).addTo(map);
    }
}

// --- MAIN ROUTE LOGIC ---
async function calcRoute() {
    let s = markers.src ? [markers.src.getLatLng().lat, markers.src.getLatLng().lng] : null;
    let d = markers.dst ? [markers.dst.getLatLng().lat, markers.dst.getLatLng().lng] : null;
    if (!s || !d) return alert("Set Start & End points first");

    // 1. Get Polyline from OSRM
    const url = `https://router.project-osrm.org/route/v1/driving/${s[1]},${s[0]};${d[1]},${d[0]}?overview=full&geometries=polyline`;

    try {
        const res = await fetch(url).then(r => r.json());

        if (res.routes && res.routes[0]) {
            const encodedPoly = res.routes[0].geometry;

            // Clear old route
            routeLayerGroup.clearLayers();

            // 2. Send to Python Backend for Elevation & Slopes
            const pythonRes = await fetch(`${PYTHON_API_URL}/route-elevation?poly=${encodeURIComponent(encodedPoly)}`);

            if (!pythonRes.ok) throw new Error("Python Elevation API failed");

            const data = await pythonRes.json();
            const points = data.points;

            // 3. Draw Gradient Segments
            myRoute = points.map(p => [p.lat, p.lon]);

            // Iterate through points to draw colored segments
            for (let i = 0; i < points.length - 1; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];

                const slope = p1.slope_pct || 0;
                // Use slope from the start point of the segment
                const color = getGradientColor(slope);

                L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], {
                    color: color,
                    weight: 6,
                    // opacity: 0.9,
                    // lineCap: 'round' // Makes the joints smoother
                }).addTo(routeLayerGroup);
            }

            map.fitBounds(routeLayerGroup.getBounds());

            // Upload simple route to Supabase
            uploadMyState(myRoute[0], 0, myRoute);

            if (window.innerWidth < 768) document.getElementById('controlsPanel').classList.remove('open');

            metrics = { speed: 0, dist: 0, time: 0, start: null, cal: 0 };
            updateStats();

            // 4. Generate Real Chart
            generateRealElevation(points, data.total_ascent_m, data.total_descent_m, data.difficulty);
        }
    } catch (err) {
        console.error(err);
        alert("Routing failed. Ensure Python main.py is running.");
    }
}

// --- 6-LEVEL COLOR GRADING LOGIC ---
function getGradientColor(slope) {
    let color;
    // 6. Extreme Uphill (Dark Red) - Greater than 12%
    if (slope > 8) color = "#d73027";       // steep uphill
    else if (slope > 4) color = "#fc8d59";  // moderate uphill
    else if (slope > 1) color = "#fee08b";  // mild uphill
    else if (slope < -8) color = "#4575b4"; // steep downhill
    else if (slope < -4) color = "#74add1";
    else if (slope < -1) color = "#abd9e9";
    else color = "blue";                 // flat     
    return color;


}

// --- REAL ELEVATION CHART ---
function generateRealElevation(points, ascent, descent, diff) {
    const el = document.getElementById('elevGraph');
    el.style.display = 'block';

    const elevs = points.map(p => p.elev_m || 0);
    const min = Math.min(...elevs);
    const max = Math.max(...elevs);
    const range = max - min || 1;

    // Create SVG Path
    let pathD = `M 0,100 `;
    const width = 100;
    const len = elevs.length;

    elevs.forEach((y, i) => {
        const xPos = (i / (len - 1)) * width;
        const yPos = 100 - ((y - min) / range) * 80 - 10;
        pathD += `L ${xPos},${yPos} `;
    });

    pathD += `L 100,100 Z`;

    el.innerHTML = `
        <div style="font-size:10px; color:#aaa; display:flex; justify-content:space-between; margin-bottom:4px;">
            <span>High: ${Math.round(max)}m</span>
            <span>Asc: +${Math.round(ascent)}m</span>
            <span style="color:${getDiffColor(diff)}">${diff}</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%; height:60px; filter: drop-shadow(0 0 2px ${me.color});">
            <defs>
                <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:${me.color};stop-opacity:1" />
                    <stop offset="100%" style="stop-color:${me.color};stop-opacity:0" />
                </linearGradient>
            </defs>
            <path d="${pathD}" fill="url(#grad)" stroke="${me.color}" stroke-width="1"/>
        </svg>
    `;
}

function getDiffColor(d) {
    if (d === "Easy") return "#10b981";
    if (d === "Moderate") return "#facc15";
    if (d === "Hard") return "#ea580c";
    return "#dc2626"; // Very Hard
}

function toggleGhost() {
    if (ghostTimer) {
        clearInterval(ghostTimer); ghostTimer = null;
        document.getElementById('ghostBtn').innerText = "👻 Sim";
        document.getElementById('ghostBtn').classList.add('btn-sec');
    } else {
        if (myRoute.length < 2) return alert("Route first!");
        document.getElementById('ghostBtn').innerText = "Stop";
        document.getElementById('ghostBtn').classList.remove('btn-sec');

        let i = 0;
        metrics.start = Date.now();

        ghostTimer = setInterval(() => {
            if (i >= myRoute.length) i = 0;
            const pt = myRoute[i];

            metrics.speed = (Math.random() * 15) + 20;
            metrics.dist += 0.003;
            metrics.cal += 0.04;
            if (metrics.start) metrics.time = Math.floor((Date.now() - metrics.start) / 1000);

            updateMyMarker(pt[0], pt[1]);
            uploadMyState(pt, metrics.speed, myRoute);
            updateStats();

            i += 3;
        }, 1000);
    }
}

function updateMyMarker(lat, lon) {
    if (myMarker) myMarker.setLatLng([lat, lon]);
    else {
        const icon = L.divIcon({
            className: 'pulse',
            html: `<div style="background:${me.color}; width:100%; height:100%; border-radius:50%"></div>`
        });
        myMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(map);
    }
}

function updateStats() {
    const m = Math.floor(metrics.time / 60).toString().padStart(2, '0');
    const s = (metrics.time % 60).toString().padStart(2, '0');
    document.getElementById('speed').innerText = metrics.speed.toFixed(1);
    document.getElementById('dist').innerText = metrics.dist.toFixed(2);
    document.getElementById('time').innerText = `${m}:${s}`;
    document.getElementById('kcal').innerText = Math.floor(metrics.cal);
}

async function uploadMyState(pos, spd, route) {
    if (!session) return;
    const lat = Array.isArray(pos) ? pos[0] : pos;
    const lon = Array.isArray(pos) ? pos[1] : pos;

    await supabase.from('locations').upsert({
        session_id: session,
        user_id: me.id,
        username: me.name,
        lat: lat,
        lon: lon,
        speed: spd,
        color: me.color,
        route_coords: route
    }, { onConflict: 'session_id,user_id' });
}

async function syncDestination(lat, lng) {
    await supabase.from('sessions').upsert({
        id: session,
        route: { type: 'dest_sync', lat, lng }
    });
}