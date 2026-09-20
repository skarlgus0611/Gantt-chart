const API_URL =
  "https://script.google.com/macros/s/AKfycbz8XK85cnU9VMpS4cKU4mC6QLtjGSMxuy0bGErXzr--P5qOWEozhv88ElVSZBhGQUr0bA/exec?api=1&key=21cb42f7a0ea44838dea501764474553";

async function loadData() {
  const status = document.getElementById("status");
  const gantt = document.getElementById("gantt");

  status.textContent = "Google Sheets 데이터를 불러오는 중...";

  try {
    const response = await fetch(API_URL);

    if (!response.ok) {
      throw new Error("HTTP 오류: " + response.status);
    }

    const result = await response.json();

    if (!result.ok) {
      throw new Error(result.error || "API 오류");
    }

    console.log("API 데이터:", result.data);

    status.textContent =
      `불러오기 성공: 작업 ${result.data.tasks.length}개 / 카테고리 ${result.data.categories.length}개`;

    gantt.innerHTML = `
      <h2>연결 성공!</h2>
      <p>Google Sheets에서 데이터를 정상적으로 가져왔습니다.</p>
    `;

  } catch (error) {

    console.error(error);

    status.textContent =
      "데이터를 불러오지 못했습니다: " + error.message;

    gantt.innerHTML = `
      <p style="color:red;">
        API 연결에 실패했습니다.
      </p>
    `;
  }
}

document
  .getElementById("reloadBtn")
  .addEventListener("click", loadData);

loadData();
