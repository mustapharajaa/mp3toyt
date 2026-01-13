function toggleForms() {
    const loginForm = document.getElementById('login-form');
    const regForm = document.getElementById('register-form');
    if (loginForm.classList.contains('hidden')) {
        loginForm.classList.remove('hidden');
        regForm.classList.add('hidden');
    } else {
        loginForm.classList.add('hidden');
        regForm.classList.remove('hidden');
    }
    // Clear errors
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('register-error').style.display = 'none';
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    btn.disabled = true;
    btn.textContent = 'Logging in...';
    errorEl.style.display = 'none';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.success) {
            window.location.href = '/app';
        } else {
            errorEl.textContent = data.message;
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.textContent = 'An error occurred. Please try again.';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Login';
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;
    const errorEl = document.getElementById('register-error');
    const btn = document.getElementById('reg-btn');

    btn.disabled = true;
    btn.textContent = 'Creating Account...';
    errorEl.style.display = 'none';

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.success) {
            // Auto login logic
            const loginRes = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const loginData = await loginRes.json();

            if (loginData.success) {
                window.location.href = '/app';
            } else {
                // Determine if we should show error or fallback to login form
                errorEl.textContent = 'Registration successful, but auto-login failed. Please log in manually.';
                errorEl.style.display = 'block';
                setTimeout(() => toggleForms(), 2000); // Switch after delay
            }
        } else {
            errorEl.textContent = data.message;
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.textContent = 'An error occurred. Please try again.';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign Up';
    }
}
