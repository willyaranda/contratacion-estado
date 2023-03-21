import os, json
import pandas as pd
from datetime import datetime

path_to_json = '../dump/'
json_files = [pos_json for pos_json in os.listdir(path_to_json) if pos_json.endswith('.json')]

df = pd.DataFrame(columns=['id', 'updated', 'money', 'status'])

for index, js in enumerate(json_files):
    with open(os.path.join(path_to_json, js)) as json_file:
        json_text = json.load(json_file)

        id = json_text['cac-place-ext:ContractFolderStatus']['cbc:ContractFolderID']
        money = json_text['cac-place-ext:ContractFolderStatus']['cac:ProcurementProject']['cac:BudgetAmount']['cbc:TotalAmount']['#text']
        summary = json_text['summary']['#text']
        updated = json_text['updated']
        status = summary[len(summary) - 3:len(summary)]
        # dt_object = datetime.fromisoformat(updated)

        df.loc[index] = [id, updated, money, status]

# now that we have the pertinent json data in our DataFrame let's look at it
# Convert data frame updated field to pandas datetime
# 2022-11-22T14:09:38.836+01:00
df['updated'] = pd.to_datetime(df['updated'], format="%Y-%m-%dT%H:%M:%S.%f")
df.sort_values(by=['updated'], inplace=True, ascending=False)

#df.groupby(df.updated.dt.month)['money'].sum().plot(kind='bar')

df.plot.hist(column='money', by='status', bins=20)