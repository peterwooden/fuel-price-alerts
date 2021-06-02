import React, { useCallback, useEffect, useState } from 'react';
import './App.css';
import Amplify, { Auth } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import {
    BrowserRouter as Router,
    Switch,
    Route,
    Link,
    Redirect,
} from 'react-router-dom';
import Stations from './stations';
import { Map, Marker, Bounds } from 'pigeon-maps';
import { useDebounce } from 'use-debounce';
import axios from 'axios';

const ALERT_SUBSCRIPTIONS_URL =
    'https://5r4621gsb7.execute-api.ap-southeast-2.amazonaws.com/prod/alert-subscriptions';

Amplify.configure({
    Auth: {
        // REQUIRED only for Federated Authentication - Amazon Cognito Identity Pool ID
        //identityPoolId: 'XX-XXXX-X:XXXXXXXX-XXXX-1234-abcd-1234567890ab',

        // REQUIRED - Amazon Cognito Region
        region: 'ap-southeast-2',

        // OPTIONAL - Amazon Cognito User Pool ID
        userPoolId: 'ap-southeast-2_0FfD1T3W3',

        // OPTIONAL - Amazon Cognito Web Client ID (26-char alphanumeric string)
        userPoolWebClientId: '2bu6oemq362ll86rqifn3piimd',

        // OPTIONAL - Enforce user authentication prior to accessing AWS resources or not
        mandatorySignIn: true,

        // OPTIONAL - Manually set the authentication flow type. Default is 'USER_SRP_AUTH'
        //authenticationFlowType: 'USER_PASSWORD_AUTH',
    },
});

const arrAvg = (arr: number[]) => arr.reduce((a,b) => a + b, 0) / arr.length

const AccountPage = withAuthenticator(() => {
    const fuelTypes = [
        'U91',
        'P95',
        'E10',
        'P98',
        'DL',
        'EV',
        'B20',
        'E85',
        'LPG',
        'PDL',
    ];
    const [fuelType, setFuelType] = useState<string>(fuelTypes[0]);

    const [selectedStations, setSelectedStations] = useState<typeof Stations>(
        []
    );

    useEffect(() => setSelectedStations([]), [fuelType]);

    const [center, setCenter] = useState<[number, number]>([
        -33.8688, 151.2093,
    ]);
    const [zoom, setZoom] = useState(13);
    const [bounds, setBounds] = useState<Bounds>({
        ne: [0, 0],
        sw: [0, 0],
    });

    const [debouncedBounds] = useDebounce(bounds, 500);

    const [relevantStations, setRelevantStations] = useState<typeof Stations>(
        []
    );

    useEffect(() => {
        const filteredStations = Stations.filter(
            (station) =>
                debouncedBounds.sw[0] < station.latitude &&
                station.latitude < debouncedBounds.ne[0] &&
                debouncedBounds.sw[1] < station.longitude &&
                station.longitude < debouncedBounds.ne[1] &&
                station.fuel_types.includes(fuelType)
        );
        if (filteredStations.length > 100) {
            setRelevantStations([]);
        } else {
            setRelevantStations(filteredStations);
        }
    }, [debouncedBounds, fuelType]);

    const [pending, setPending] = useState(false);

    const subscribeCallback = useCallback(async () => {
        setPending(true);
        const jwt = (await Auth.currentSession()).getIdToken().getJwtToken();
        axios
            .post(
                ALERT_SUBSCRIPTIONS_URL,
                {
                    stations: selectedStations.map((station) => station.code),
                    fuelType,
                },
                {
                    headers: { Authorization: `Bearer ${jwt}` },
                }
            )
            .then(() => setPending(false))
            .catch((err) => {
                console.error(err);
                alert('Error in saving subscriptions.');
            });
    }, [selectedStations, fuelType]);

    // Load the current subscriptions
    useEffect(() => {
        async function fetchCurrentSubscriptions() {
            const jwt = (await Auth.currentSession())
                .getIdToken()
                .getJwtToken();
            const response = (
                await axios.get(ALERT_SUBSCRIPTIONS_URL, {
                    headers: { Authorization: `Bearer ${jwt}` },
                })
            ).data;
            const data: { stationCode: string; fuelType: string }[] = response;

            if (data.length) {
                setFuelType(data[0].fuelType); // TODO: Find a better way to represent the data so that more than just one layer of fuel types are active at once
                const stationCodes = new Set(
                    data.map((record) => record.stationCode)
                );
                const selectedStations = Stations.filter((station) =>
                stationCodes.has(String(station.code))
            );
                setSelectedStations(
                    selectedStations
                );
                setCenter([arrAvg(selectedStations.map(station => station.latitude)), arrAvg(selectedStations.map(station => station.longitude))]);
            }
        }
        fetchCurrentSubscriptions();
    }, []);

    const [signedIn, setSignedIn] = useState(true);


    if (!signedIn) {
        return <Redirect to="/" />;
    }

    return (
        <div className="w-screen">
            <div className="shadow-lg w-full py-2">
                <div className="container mx-auto flex flex-row justify-between px-5">
                    <span className="font-bold text-xl">Fuel Price Alerts</span>
                    <button
                        onClick={async () => {
                            await Auth.signOut();
                            setSignedIn(false);
                        }}
                        className="inset-0 flex items-center justify-center bg-white hover:bg-gray-200 text-gray-600 text-md leading-6 font-semibold py-1 px-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-offset-2 focus:ring-offset-white focus:ring-gray-500 focus:outline-none transition-colors duration-200"
                    >
                        Sign out
                    </button>
                </div>
            </div>
            <div className="container mx-auto my-5">
                <div>
                    <div className="my-4">
                        <span className="text-lg font-semibold">
                            1. Select fuel type
                        </span>
                        <select
                            onChange={(e) => setFuelType(e.target.value)}
                            value={fuelType}
                            className="border-2 rounded border-gray-400 px-2 ml-4"
                        >
                            {fuelTypes.map((fuelType, i) => (
                                <option value={fuelType} key={i}>
                                    {fuelType}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="text-lg font-semibold">
                        2. Select up to 5 stations
                    </div>
                    <div className="shadow m-2">
                        <Map
                            height={350}
                            center={center}
                            zoom={zoom}
                            onBoundsChanged={({ center, zoom, bounds }) => {
                                setCenter(center);
                                setZoom(zoom);
                                setBounds(bounds);
                            }}
                        >
                            {relevantStations.map((station, i) => (
                                <Marker
                                    key={i}
                                    anchor={[
                                        station.latitude,
                                        station.longitude,
                                    ]}
                                    color={
                                        selectedStations.includes(station)
                                            ? '#FF3333'
                                            : undefined
                                    }
                                    onClick={() =>
                                        setSelectedStations(
                                            (selectedStations) => {
                                                if (
                                                    selectedStations.includes(
                                                        station
                                                    )
                                                ) {
                                                    return selectedStations.filter(
                                                        (s) => s !== station
                                                    );
                                                } else {
                                                    return selectedStations.concat(
                                                        station
                                                    );
                                                }
                                            }
                                        )
                                    }
                                />
                            ))}
                        </Map>
                    </div>
                    <div>
                        <ul className="list-disc list-inside">
                            {selectedStations.map((s, i) => (
                                <li key={i}>{s.name}</li>
                            ))}
                        </ul>
                    </div>
                    <div className="my-3">
                        {selectedStations.length > 0 &&
                            (selectedStations.length <= 5 ? (
                                pending ? <button disabled
                                className="inset-0 flex items-center justify-center bg-gray-500 text-white text-md leading-6 font-semibold py-1 px-4 rounded-lg"
                            >
                                Saving...
                            </button>
                                : <button
                                    className="inset-0 flex items-center justify-center bg-blue-600 hover:bg-blue-400 text-white text-md leading-6 font-semibold py-1 px-4 rounded-lg focus:ring-2 focus:ring-offset-2 focus:ring-offset-white focus:ring-blue-600 focus:outline-none transition-colors duration-200"
                                    onClick={subscribeCallback}
                                >
                                    Save
                                </button>
                            ) : (
                                <span className="text-red-600 font-bold">
                                    Too many
                                </span>
                            ))}
                    </div>
                </div>
            </div>
        </div>
    );
}, {});

function App() {
    return (
        <Router>
            <Switch>
                <Route exact path="/">
                    Welcome to Fuel Price Alerts!{' '}
                    <Link to="/account" className="underline text-blue-600">
                        Sign in/Sign up
                    </Link>
                </Route>
                <Route path="/account">
                    <AccountPage />
                </Route>
            </Switch>
        </Router>
    );
}

export default App;
