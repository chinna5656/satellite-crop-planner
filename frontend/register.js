document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    const errorMsg = document.getElementById('errorMessage');
    const successMsg = document.getElementById('successMessage');
    const submitBtn = document.getElementById('submitBtn');

    // ซ่อนข้อความเก่าและเปลี่ยนปุ่มเป็นสถานะโหลด
    errorMsg.style.display = 'none';
    successMsg.style.display = 'none';
    submitBtn.innerText = 'กำลังประมวลผล...';
    submitBtn.disabled = true;

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            // สมัครสำเร็จ
            successMsg.innerText = data.message || 'สมัครสมาชิกสำเร็จ! กำลังพากลับไปหน้าเข้าสู่ระบบ...';
            successMsg.style.display = 'block';
            
            // รอ 1.5 วินาที แล้วเด้งกลับไปหน้า login
            setTimeout(() => {
                window.location.href = '/login'; 
            }, 1500);
        } else {
            // กรณี Username ซ้ำ หรือ Error อื่นๆ
            errorMsg.innerText = data.detail || 'ไม่สามารถสมัครสมาชิกได้';
            errorMsg.style.display = 'block';
            submitBtn.innerText = 'ยืนยันการสมัครสมาชิก';
            submitBtn.disabled = false;
        }
    } catch (error) {
        errorMsg.innerText = 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์หลังบ้านได้';
        errorMsg.style.display = 'block';
        submitBtn.innerText = 'ยืนยันการสมัครสมาชิก';
        submitBtn.disabled = false;
    }
});