// Constants for staging results
const STAGING_RESULTS = {
    I: "Evre I",
    II: "Evre II",
    III: "Evre III",
    IVA: "Evre IVA",
    IVB: "Evre IVB",
    UNKNOWN: "Daha fazla bilgi gerekli"
};

// Function to show/hide tabs
function showTab(tabName) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Remove active class from all tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Show the selected tab content
    document.getElementById(tabName).classList.add('active');
    
    // Add active class to the clicked tab
    event.target.classList.add('active');
}

// Function to update UI visibility based on conditions
function updateUIVisibility() {
    const ageAbove55 = document.getElementById('ageAbove55').checked;
    const distantMetastasis = document.getElementById('distantMetastasis').checked;
    
    // Show/hide Gross ETE option
    document.getElementById('grossETEgroup').style.display = 
        (ageAbove55 && !distantMetastasis) ? 'block' : 'none';
    
    // Show/hide Affected Structures section
    document.getElementById('affectedStructures').style.display = 
        (ageAbove55 && !distantMetastasis && document.getElementById('grossETE').checked) ? 'block' : 'none';
    
    // Show/hide Tumor Size section
    document.getElementById('tumorSize').style.display = 
        (ageAbove55 && !distantMetastasis && !document.getElementById('grossETE').checked) ? 'block' : 'none';
    
    // Show/hide Lymph Nodes section
    document.getElementById('lymphNodes').style.display = 
        (ageAbove55 && !distantMetastasis && !document.getElementById('grossETE').checked && 
         document.getElementById('tumorSizeLessThan4cm').checked) ? 'block' : 'none';
}

// Function to calculate the stage
function calculateStage() {
    // Update UI visibility first
    updateUIVisibility();
    
    // Get all input values
    const ageAbove55 = document.getElementById('ageAbove55').checked;
    const distantMetastasis = document.getElementById('distantMetastasis').checked;
    const grossETE = document.getElementById('grossETE').checked;
    const tumorSizeLessThan4cm = document.getElementById('tumorSizeLessThan4cm').checked;
    const affectedStructures = document.getElementById('affectedStructuresSelect').value;
    const lymphNodes = document.getElementById('lymphNodesSelect').value;
    
    let stage;
    
    if (!ageAbove55) {
        // Age < 55
        if (distantMetastasis) {
            stage = STAGING_RESULTS.II;
        } else {
            stage = STAGING_RESULTS.I;
        }
    } else {
        // Age ≥ 55
        if (distantMetastasis) {
            stage = STAGING_RESULTS.IVB;
        } else {
            if (!grossETE) {
                if (tumorSizeLessThan4cm) {
                    if (lymphNodes === 'NONE') {
                        stage = STAGING_RESULTS.I;
                    } else {
                        stage = STAGING_RESULTS.II;
                    }
                } else {
                    stage = STAGING_RESULTS.II;
                }
            } else {
                // Gross ETE present
                switch (affectedStructures) {
                    case 'T3b':
                        stage = STAGING_RESULTS.II;
                        break;
                    case 'T4a':
                        stage = STAGING_RESULTS.III;
                        break;
                    case 'T4b':
                        stage = STAGING_RESULTS.IVA;
                        break;
                    default:
                        stage = STAGING_RESULTS.UNKNOWN;
                }
            }
        }
    }
    
    // Update the result display
    document.getElementById('stagingResult').textContent = `Evre: ${stage}`;
}

// Initialize the UI
document.addEventListener('DOMContentLoaded', function() {
    // Add event listeners to all inputs
    document.getElementById('ageAbove55').addEventListener('change', calculateStage);
    document.getElementById('distantMetastasis').addEventListener('change', calculateStage);
    document.getElementById('grossETE').addEventListener('change', calculateStage);
    document.getElementById('tumorSizeLessThan4cm').addEventListener('change', calculateStage);
    document.getElementById('affectedStructuresSelect').addEventListener('change', calculateStage);
    document.getElementById('lymphNodesSelect').addEventListener('change', calculateStage);
    
    // Initial calculation
    calculateStage();
}); 