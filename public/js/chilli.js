// --- CONFIG ---
// Replace with your own keys if needed, using the demo ones from context
const SUPABASE_URL = 'https://dcljhabgelsstbffmlou.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjbGpoYWJnZWxzc3RiZmZtbG91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3MDc3OTEsImV4cCI6MjA3OTI4Mzc5MX0.HJe6hZ5Wc15zkR9vqlyNTpP_NUnABYCeq9EqJBymVU0';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// --- MAP SETUP ---
const map = L.map('map', { zoomControl: false }).setView([0, 0], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
//     , {
//     attribution: '&copy; OSM'
// }
).addTo(map);

// --- USER STATE ---
const randomHue = Math.floor(Math.random() * 360);
let me = { 
    id: 'u_' + Math.floor(Math.random() * 999999), 
    name: 'Rider', 
    color: `hsl(${randomHue}, 100%, 60%)` // Distinct color for me
};

let session = null;
let myRoute = []; 
let myLayer = null; 
let myMarker = null;
let teammates = {}; // Stores other users' map layers
let markers = { src: null, dst: null };
let ghostTimer = null;
let metrics = { speed: 0, dist: 0, time: 0, start: null, cal: 0 };

// --- UI INTERACTION ---
document.getElementById('toggle-controls').addEventListener('click', () => {
    document.getElementById('controlsPanel').classList.toggle('open');
});

// --- AUTO-LOCATE ---
window.onload = function() {
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
            map.setView([20, 78], 4); // Default view
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
        if(session) syncDestination(lat, lng);
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

    // 1. Listen for teammates moving
    supabase.channel('loc_' + id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'locations', filter: `session_id=eq.${id}` },
        payload => handleTeammateUpdate(payload.new))
        .subscribe();

    // 2. Listen for Destination changes
    supabase.channel('sess_' + id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${id}` },
        payload => {
            if(payload.new?.route?.type === 'dest_sync') setDestination(payload.new.route.lat, payload.new.route.lng, "Host Dest");
        })
        .subscribe();

    // 3. Load existing users immediately
    const { data: existingUsers } = await supabase.from('locations').select('*').eq('session_id', id);
    if(existingUsers) {
        existingUsers.forEach(u => {
            if(u.user_id !== me.id) handleTeammateUpdate(u);
        });
    }

    // 4. Load Destination
    const { data: sessData } = await supabase.from('sessions').select('route').eq('id', id).single();
    if(sessData?.route?.type === 'dest_sync') setDestination(sessData.route.lat, sessData.route.lng, "Host Dest");
}

// --- TEAMMATE RENDERING ---
function handleTeammateUpdate(data) {
    if (data.user_id === me.id) return;

    let tm = teammates[data.user_id];

    if (!tm) {
        // New Teammate Joined
        const el = document.createElement('div');
        el.className = 'tm-row';
        el.id = `tm-li-${data.user_id}`;
        // Show their distinct color in the list
        el.innerHTML = `<div class="color-dot" style="background:${data.color}; box-shadow: 0 0 5px ${data.color}"></div> ${data.username}`;
        document.getElementById('tmList').appendChild(el);

        const icon = L.divIcon({ 
            className: 'tm-icon', 
            html: `<div style="background:${data.color}; width:100%; height:100%; border-radius:50%"></div>` 
        });
        const marker = L.marker([data.lat, data.lon], { icon }).addTo(map).bindPopup(data.username);

        tm = { marker, polyline: null, color: data.color };
        teammates[data.user_id] = tm;
    } else {
        // Update name just in case
        document.getElementById(`tm-li-${data.user_id}`).innerHTML = `<div class="color-dot" style="background:${data.color}"></div> ${data.username}`;
    }

    // Update Position
    tm.marker.setLatLng([data.lat, data.lon]);

    // Update Route Line (Dashed, Distinct Color)
    if (data.route_coords && Array.isArray(data.route_coords) && data.route_coords.length > 0) {
        if (tm.polyline) map.removeLayer(tm.polyline);
        tm.polyline = L.polyline(data.route_coords, {
            color: data.color,
            weight: 4,
            opacity: 0.7,
            dashArray: '5, 10'
        }).addTo(map);
    }
}

// --- ROUTING & SIMULATION ---
async function calcRoute() {
    let s = markers.src ? [markers.src.getLatLng().lat, markers.src.getLatLng().lng] : null;
    let d = markers.dst ? [markers.dst.getLatLng().lat, markers.dst.getLatLng().lng] : null;
    if(!s || !d) return alert("Set Start & End points first");

    const url = `https://router.project-osrm.org/route/v1/driving/${s[1]},${s[0]};${d[1]},${d[0]}?overview=full&geometries=geojson`;
    const res = await fetch(url).then(r => r.json());

    if (res.routes && res.routes[0]) {
        const route = res.routes[0];
        myRoute = route.geometry.coordinates.map(c => [c[1], c[0]]);

        if (myLayer) map.removeLayer(myLayer);
        // Draw My Route (Solid)
        myLayer = L.polyline(myRoute, { color: me.color, weight: 6 }).addTo(map);
        map.fitBounds(myLayer.getBounds());
        
        // Upload initial route so others see it
        uploadMyState(myRoute[0], 0, myRoute);

        // Close sidebar on mobile
        if(window.innerWidth < 768) document.getElementById('controlsPanel').classList.remove('open');
        
        // Reset metrics
        metrics = { speed: 0, dist: 0, time: 0, start: null, cal: 0 };
        updateStats();
        generateElevation();
    }
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
            
            // Fake Physics
            metrics.speed = (Math.random() * 15) + 20; // 20-35 km/h
            metrics.dist += 0.003; 
            metrics.cal += 0.04;
            if(metrics.start) metrics.time = Math.floor((Date.now() - metrics.start)/1000);

            updateMyMarker(pt[0], pt[1]);
            uploadMyState(pt, metrics.speed, myRoute);
            updateStats();
            
            i += 4; // Skip points for speed
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
    const m = Math.floor(metrics.time / 60).toString().padStart(2,'0');
    const s = (metrics.time % 60).toString().padStart(2,'0');
    document.getElementById('speed').innerText = metrics.speed.toFixed(1);
    document.getElementById('dist').innerText = metrics.dist.toFixed(2);
    document.getElementById('time').innerText = `${m}:${s}`;
    document.getElementById('kcal').innerText = Math.floor(metrics.cal);
}

// --- DATABASE SYNC ---
async function uploadMyState(pos, spd, route) {
    if(!session) return;
    const lat = Array.isArray(pos) ? pos[0] : pos;
    const lon = Array.isArray(pos) ? pos[1] : pos;

    // Send my Color and Route to DB
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

function generateElevation() {
    const el = document.getElementById('elevGraph');
    el.style.display = 'block';
    // Simple visual placeholder using my color
    el.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M0,100 L0,50 L20,40 L40,70 L60,30 L80,60 L100,50 L100,100 Z" fill="${me.color}" opacity="0.4"/></svg>`;
}