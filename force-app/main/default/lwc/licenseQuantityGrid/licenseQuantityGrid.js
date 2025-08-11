import { LightningElement, api, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import getLicenseData from '@salesforce/apex/LicenseQuantityController.getLicenseData';
import getCustomerSuccessModuleConfig from '@salesforce/apex/LicenseQuantityController.getCustomerSuccessModuleConfig';
import saveLicenseData from '@salesforce/apex/LicenseQuantityController.saveLicenseData';

export default class LicenseQuantityGrid extends LightningElement {
    @api recordId; // Customer_Success_Module__c record ID
    @track gridData = [];
    @track isLoading = false;
    @track hasChanges = false;
    @track pendingChanges = new Map();
    @track draftValues = [];

    gradeLabels = ['K', '1', '2', '3', '4', '5', '6', '7', '8'];
    
    // Store the wired data for a potential refreshApex call
    wiredLicenseData;
    wiredConfigData;

    // The configuration data from the server, used for dynamic columns
    @track configData;

    @wire(getCustomerSuccessModuleConfig, { customerSuccessModuleId: '$recordId' })
    wiredConfig(result) {
        this.wiredConfigData = result; 
        if (result.data) {
            this.configData = result.data; 
            console.log('CSM Config received:', this.configData);
            if (this.wiredLicenseData) {
                refreshApex(this.wiredLicenseData);
            }
        } else if (result.error) {
            console.log('CSM Config error (expected if fields dont exist):', result.error);
        }
    }

    @wire(getLicenseData, { customerSuccessModuleId: '$recordId' })
    wiredGetLicenseData(result) {
        this.wiredLicenseData = result; 
        if (result.data) {
            this.processLicenseData(result.data);
            console.log('License data received:', result.data);
        } else if (result.error) {
            this.showToast('Error', 'Failed to load license data: ' + result.error.body.message, 'error');
        }
    }

    get columns() {
        if (!this.configData) {
            return [];
        }
        const maxCols = this.configData.F5_Contract_Length__c ? parseInt(this.configData.F5_Contract_Length__c, 10) : 7; // Default to 7 if not set
        const zeroColumn = { label: 'Grade', fieldName: 'grade', type: 'text', editable: false, fixedWidth: 80 };
        let columns = [zeroColumn];

        // Store the initial date to use as a starting point for the loop
        let currentDate = this.configData.F5_LMS_Start_Date__c;
        let nextDate = this.configData.F5_Initial_Renewal_date__c;

        for (let i = 1; i <= maxCols; i++) {
            let dateLabel;

            if (i === 1) {
                // Use the LMS Start Date for the first column, formatted
                dateLabel = currentDate ? this.americanDateFormat(currentDate) : 'Year 1';
            } else {
                dateLabel = nextDate ? this.americanDateFormat(this.addYearsToDateString(nextDate, (i - 1))) : `Year ${i-1}`;
            }

            columns.push({
                label: dateLabel,
                fieldName: `year${i}`,
                type: 'number',
                editable: true,
                typeAttributes: { minimumFractionDigits: 0, maximumFractionDigits: 0 },
                cellAttributes: {
                    class: { fieldName: 'rowClass' }
                }
            });
        }
        return columns;
    }

    // Helper method to calculate the totals for each year
    calculateTotals(data, maxYears) {
        // Create a row object for the totals
        const totals = { id: 'totals-row', grade: 'Total', rowClass: 'total-row slds-text-heading_small slds-text-color_success' };
        for (let year = 1; year <= maxYears; year++) {
            const yearKey = `year${year}`;
            // Use reduce to sum the values for the current year across all data rows
            totals[yearKey] = data.reduce((sum, row) => sum + (row[yearKey] || 0), 0);
        }
        return totals;
    }

    processLicenseData(data) {
        const dataMap = new Map();
        data.forEach(record => {
            const key = `${record.Grade_Level__c}_${record.Year__c}`;
            dataMap.set(key, record.License_Quantity__c);
        });

        const maxYears = (this.configData && this.configData.F5_Contract_Length__c) ? parseInt(this.configData.F5_Contract_Length__c, 10) : 5;
        
        // Build the main data rows
        const mainData = this.gradeLabels.map((grade, index) => {
            const row = { id: `row-${index}`, grade: grade, rowClass: '' }; 
            
            for (let year = 1; year <= maxYears; year++) {
                const key = `${grade}_${year}`;
                row[`year${year}`] = dataMap.get(key) || null;
            }
            return row;
        });

        // Calculate and add the totals row
        const totalsRow = this.calculateTotals(mainData, maxYears);
        this.gridData = [...mainData, totalsRow];
    }

    // Validation method to check if totals exceed maximum license limit
    validateTotals(dataRows) {
        console.log('Validating totals for data rows:', JSON.stringify(dataRows, null, 2));
        const maxLicense = this.configData?.F5_Maximum_License__c ? parseInt(this.configData.F5_Maximum_License__c, 10) : null;
        console.log('Validating totals for data rows max per year:', maxLicense);
        if (!maxLicense) {
            return { isValid: true, errors: [] };
        }

        const maxYears = (this.configData && this.configData.F5_Contract_Length__c) ? parseInt(this.configData.F5_Contract_Length__c, 10) : 5;
        const errors = [];

        for (let year = 1; year <= maxYears; year++) {
            const yearKey = `year${year}`;
            const total = dataRows.reduce((sum, row) => sum + (row[yearKey] || 0), 0);
            
            if (total > maxLicense) {
                const yearLabel = this.getYearLabel(year);
                errors.push(`${yearLabel}: Total (${total}) exceeds maximum license limit (${maxLicense})`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    // Helper method to get year label for validation messages
    getYearLabel(yearNum) {
        const columns = this.columns;
        if (columns && columns[yearNum]) {
            return columns[yearNum].label;
        }
        return `Year ${yearNum}`;
    }

    handleDraftValueChange(event) {
        let draftValues = event.detail.draftValues;
        
        // Filter out any draft values for the totals row to prevent editing
        draftValues = draftValues.filter(draft => draft.id !== 'totals-row');
        
        // Update the component's draftValues to reflect the filtered values
        this.draftValues = draftValues;
        
        if (draftValues.length === 0) {
            return; // No valid changes to process
        }

        this.hasChanges = true; 

        const updatedPendingChanges = new Map(this.pendingChanges); 

        // Filter out the totals row before processing changes, so it doesn't get treated as editable
        const originalDataRows = this.gridData.filter(row => row.id !== 'totals-row');

        draftValues.forEach(draft => {
            const originalRow = originalDataRows.find(row => row.id === draft.id);
            if (!originalRow) {
                console.error('Original row not found for draft ID:', draft.id);
                return;
            }
            const grade = originalRow.grade;

            const rowIndex = originalDataRows.findIndex(row => row.id === draft.id);
            if (rowIndex !== -1) {
                originalDataRows[rowIndex] = { ...originalDataRows[rowIndex], ...draft };
            }

            Object.keys(draft).forEach(field => {
                if (field !== 'id' && field !== 'grade') { 
                    const year = field.replace('year', '');
                    const key = `${grade}_${year}`;
                    let value = draft[field];

                    if (value !== null && value !== undefined && value !== '') {
                        value = parseInt(value, 10);
                        if (isNaN(value) || value < 0) {
                            value = null; 
                        }
                    } else {
                        value = null; 
                    }

                    updatedPendingChanges.set(key, {
                        grade: grade,
                        year: year,
                        quantity: value
                    });
                }
            });
        });

        // Validate totals before updating the grid
        const validation = this.validateTotals(originalDataRows);
        
        if (!validation.isValid) {
            // Show validation errors but still allow the changes to be made
            const errorMessage = 'Validation Warnings:\n' + validation.errors.join('\n');
            this.showToast('Warning', errorMessage, 'warning');
        }

        // Recalculate totals after processing the draft changes
        const maxYears = (this.configData && this.configData.F5_Contract_Length__c) ? parseInt(this.configData.F5_Contract_Length__c, 10) : 5;
        const totalsRow = this.calculateTotals(originalDataRows, maxYears);

        this.gridData = [...originalDataRows, totalsRow];
        this.pendingChanges = updatedPendingChanges; 
    }

    async handleSave() {
        if (!this.hasChanges || this.pendingChanges.size === 0) {
            this.showToast('Info', 'No changes to save.', 'info');
            return;
        }

        // Final validation before saving
        const originalDataRows = this.gridData.filter(row => row.id !== 'totals-row');
        const validation = this.validateTotals(originalDataRows);
        
        if (!validation.isValid) {
            const errorMessage = 'Cannot save due to validation errors:\n' + validation.errors.join('\n');
            this.showToast('Error', errorMessage, 'error');
            return;
        }

        this.isLoading = true;

        try {
            const changes = Array.from(this.pendingChanges.values());
            console.log('Saving changes:', JSON.stringify(changes)); 

            await saveLicenseData({
                customerSuccessModuleId: this.recordId,
                licenseChanges: changes
            });

            this.showToast('Success', 'License quantities saved successfully', 'success');
            this.hasChanges = false;
            this.pendingChanges.clear(); 
            this.draftValues = [];

            this.template.querySelector('lightning-datatable').draftValues = [];

            await refreshApex(this.wiredLicenseData);

        } catch (error) {
            let errorMessage = 'An unknown error occurred.';
            if (error && error.body && error.body.message) {
                errorMessage = error.body.message;
            } else if (error && error.message) {
                errorMessage = error.message;
            }
            this.showToast('Error', 'Failed to save changes: ' + errorMessage, 'error');
            console.error('Save error:', error); 
        } finally {
            this.isLoading = false;
        }
    }

    handleCancel() {
        this.hasChanges = false;
        this.pendingChanges.clear();
        this.draftValues = [];

        this.template.querySelector('lightning-datatable').draftValues = [];

        refreshApex(this.wiredLicenseData);
        this.showToast('Info', 'Changes discarded.', 'info');
    }
    
    addYearsToDateString(dateString, yearsToAdd) {
        if (!dateString) return null;
        const date = new Date(dateString);
        date.setFullYear(date.getFullYear() + yearsToAdd);
        return date.toISOString().split('T')[0]; 
    }
    
    americanDateFormat(inputDate) {
        if (!inputDate) return null;
        
        // Use a regex to extract the parts of the date string
        const regex = /^(\d{4})-(\d{2})-(\d{2})$/;
        const match = inputDate.match(regex);

        if (match) {
            const [, year, month, day] = match;
            return `${month}/${day}/${year}`;
        }
        
        return null; // Return null if the input format is not YYYY-MM-DD
    }
    
    showToast(title, message, variant) {
        const event = new ShowToastEvent({
            title: title,
            message: message,
            variant: variant
        });
        this.dispatchEvent(event);
    }

    get saveButtonDisabled() {
        return !this.hasChanges || this.isLoading;
    }

    get cancelButtonDisabled() {
        return !this.hasChanges || this.isLoading;
    }
}