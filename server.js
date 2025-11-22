const express = require('express');
const path = require('path');
const app = express();

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req,res)=>{
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chilli', (req,res)=>{
    res.sendFile(path.join(__dirname, 'public', 'chilli.html'));
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Chilli Tracker running on http://localhost:${PORT}`);
});