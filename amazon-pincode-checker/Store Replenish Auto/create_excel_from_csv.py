# This file will be created as a real Excel file using pandas
# The CSV data will be loaded and saved as .xlsx for compatibility
import pandas as pd
csv_path = r"e:\Emount\Stock Reports\Claude\Store Replenish Auto\reports\default\optimization_actions_20260402_211704.csv"
xlsx_path = r"e:\Emount\Stock Reports\Claude\Store Replenish Auto\reports\default\ad_optimization_recommendations.xlsx"
df = pd.read_csv(csv_path)
df.to_excel(xlsx_path, index=False)
print("Excel file created successfully.")
