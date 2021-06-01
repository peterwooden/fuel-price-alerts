import React, { useCallback, useEffect, useState } from 'react';
import './App.css';
import Amplify, { Auth } from 'aws-amplify';
import { withAuthenticator, AmplifySignOut } from '@aws-amplify/ui-react';
import { BrowserRouter as Router, Switch, Route, Link } from 'react-router-dom';
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

    const subscribeCallback = useCallback(async () => {
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
            .then(console.log)
            .catch(err => {
                console.error(err);
                alert('Error in saving subscriptions.')
            });
    }, [selectedStations, fuelType]);

    // Load the current subscriptions
    useEffect(() => {
        async function fetchCurrentSubscriptions() {
            const jwt = (await Auth.currentSession())
                .getIdToken()
                .getJwtToken();
            const response = (await axios
                .get(
                    ALERT_SUBSCRIPTIONS_URL,
                    {
                        headers: { Authorization: `Bearer ${jwt}` },
                    }
                )).data;
            const data: { stationCode: string; fuelType: string }[] = response;

            
            if (data.length) {
                setFuelType(data[0].fuelType); // TODO: Find a better way to represent the data so that more than just one layer of fuel types are active at once
                const stationCodes = new Set(data.map(record => record.stationCode));
                setSelectedStations(Stations.filter(station => stationCodes.has(String(station.code))));
            }
        }
        fetchCurrentSubscriptions();
    }, []);

    return (
        <div className="App">
            <AmplifySignOut />
            <div>
                <div>1. Select fuel type</div>
                <div>
                    <select
                        onChange={(e) => setFuelType(e.target.value)}
                        value={fuelType}
                    >
                        {fuelTypes.map((fuelType, i) => (
                            <option value={fuelType} key={i}>{fuelType}</option>
                        ))}
                    </select>
                </div>
                <div>2. Select up to 5 stations</div>
                <div>
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
                                anchor={[station.latitude, station.longitude]}
                                color={
                                    selectedStations.includes(station)
                                        ? '#FF3333'
                                        : undefined
                                }
                                onClick={() =>
                                    setSelectedStations((selectedStations) => {
                                        if (
                                            selectedStations.includes(station)
                                        ) {
                                            return selectedStations.filter(
                                                (s) => s !== station
                                            );
                                        } else {
                                            return selectedStations.concat(
                                                station
                                            );
                                        }
                                    })
                                }
                            />
                        ))}
                    </Map>
                </div>
                <div>
                    <ul>
                        {selectedStations.map((s, i) => (
                            <li key={i}>{s.name}</li>
                        ))}
                    </ul>
                </div>
                <div>
                    {selectedStations.length > 0 &&
                        selectedStations.length <= 5 && (
                            <button onClick={subscribeCallback}>
                                Subscribe
                            </button>
                        )}
                </div>
            </div>
        </div>
    );
});

function App() {
    return (
        <Router>
            <Switch>
                <Route exact path="/">
                    Welcome to Fuel Price Alerts!{' '}
                    <Link to="/account">Sign in/Sign up</Link>
                </Route>
                <Route path="/account">
                    <AccountPage />
                </Route>
            </Switch>
        </Router>
    );
}

export default App;
