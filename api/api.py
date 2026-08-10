from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
import os
import pandas as pd
from pydantic import BaseModel
import pickle
from typing import List

from utils import PropertyDataTransformer
from npv import calculate_buy_vs_rent, NpvParams, CashFlow
import joblib

coef_ = pd.read_csv('model/coef_.csv')
pt = joblib.load('model/proptrans.pkl')


origins = [
    "http://localhost",
    "http://localhost:4200",
    "http://stellar-dev",
    "https://tokyohouseprice.web.app"
]
app = FastAPI(title="Tokyo Housing Price Prediction API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PredictionInput(BaseModel):
    is_new: bool
    is_house: bool
    orientation: str
    house_m2: int
    land_m2: int
    building_type: str
    age: int
    nearest_station_name: str
    nearest_station_minutes: int
    building_ratio: str
    floor_ratio: str
    land_shape: str
    date: int
    road: int


class Land(BaseModel):
    total: float = 0
    base: float = 0
    location: float = 0


class Building(BaseModel):
    total: float = 0
    base: float = 0
    age: float = 0


class PredictionOutput(BaseModel):
    total: float = 0
    land: Land
    building: Building
    found: bool = True


# Local-only SUUMO scraper dashboard API. Enabled with ENABLE_SCRAPER=1 for
# local dev on the Mac Studio; intentionally absent from the Cloud Run deploy.
if os.environ.get("ENABLE_SCRAPER") == "1":
    from scraper_routes import router as scraper_router
    app.include_router(scraper_router)


@app.get("/")
async def root():
    return {"message": "All good."}


@app.post("/predict")
async def predict(input_data: PredictionInput):
    x = pt.model_spec.get_model_matrix(input_data.model_dump()).T.reset_index()
    x.columns = ['coef', 'value']
    xx = x.merge(coef_, on='coef')
    xx['m'] = xx['value_x'] * xx['value_y']
    xx = xx[xx['m'] != 0]
    land = Land()
    building = Building()
    data = xx.to_dict(orient='records')
    for item in data:
        key = item['coef']
        value = item['m']
        if (key == 'is_house'):
            building.base += value
        elif (key == 'is_new'):
            building.base += value
        elif ('date:house_m2' in key):
            building.base += value
        elif (('building_type' in key) and ('age' in key)):
            building.age += value
        elif ('building_type' in key):
            building.base += value
        elif ('date:land_m2' in key):
            land.base += value
        elif ('nearest_station_name' in key):
            land.location += value
        elif ('nearest_station_minutes' in key):
            land.location += value
        elif ('road' in key):
            land.base += value
        elif ('building_ratio' in key):
            land.base += value
        elif ('floor_ratio' in key):
            land.base += value
        elif ('orientation' in key):
            land.base += value
        elif ('land_shape' in key):
            land.base += value
        land.total = land.base + land.location
        building.total = building.base + building.age

    station = f'nearest_station_name[{input_data.nearest_station_name}]:land_m2'
    res = PredictionOutput(
        total = land.total + building.total,
        land=land,
        building=building,
        found=station in x.coef.values
    )
    print(res)
    return res


@app.post('/npv', response_model=List[CashFlow])
async def npv(params: NpvParams):
    try:
        result = calculate_buy_vs_rent(params)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
