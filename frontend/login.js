document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorMsg = document.getElementById('errorMessage');
    errorMsg.style.display = 'none';
    errorMsg.innerText = '';

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            localStorage.setItem('access_token', data.access_token);
            window.location.href = '/'; 
        } else {
            errorMsg.innerText = data.detail || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
            errorMsg.style.display = 'block';
        }
    } catch (error) {
        errorMsg.innerText = 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์หลังบ้านได้';
        errorMsg.style.display = 'block';
    }
});