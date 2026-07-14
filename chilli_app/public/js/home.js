
// Mobile Menu Toggle
function toggleMenu() {
    const menu = document.getElementById('mobileMenu');
    menu.classList.toggle('active');
}

// Simple Intersection Observer for scroll reveal
const observerOptions = {
    threshold: 0.1,
    rootMargin: "0px 0px -50px 0px"
};


const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
        }
    });
}, observerOptions);

document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Navbar background on scroll
window.addEventListener('scroll', () => {
    const nav = document.getElementById('navbar');
    if (window.scrollY > 50) {
        nav.classList.add('scrolled');
    } else {
        nav.classList.remove('scrolled');
    }
});