import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('links to sign-in and to the price-waves page', () => {
    render(<App />);
    expect(screen.getByText(/sign in/i).closest('a')).toHaveAttribute('href', '/account');
    expect(screen.getByText(/how price changes move through sydney/i).closest('a')).toHaveAttribute('href', '/waves');
});
