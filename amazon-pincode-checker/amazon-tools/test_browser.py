from selenium import webdriver

driver = webdriver.Chrome()
driver.get("https://www.amazon.in")
input("Press Enter to close...")
driver.quit()
